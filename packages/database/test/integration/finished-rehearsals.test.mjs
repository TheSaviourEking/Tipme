import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  autoResolveIssues,
  claimHandle,
  createPaymentIntent,
  createQuote,
  findAttemptsToReconcile,
  finishReleaseRun,
  markAttemptInitiated,
  openIssueFromEvent,
  openReleaseRun,
  recordProviderEvent,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Each full release check misreports one pretend tip on purpose. Its attempt can never be
// verified (TipMe never invents an outcome), so once the run has finished it must stop being
// re-checked, and a mismatch issue raised after the run finished must close by itself.

async function rehearsal(t, handle) {
  const database = await useDatabase(t);
  await database.fresh();
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  const { runId } = await openReleaseRun(database.db);
  const userId = randomUUID();
  await q(`INSERT INTO users (id, phone_e164) VALUES ($1, $2)`, [
    userId,
    `+23480366${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`,
  ]);
  const { profileId } = await claimHandle(database.db, {
    userId,
    handle,
    rehearsalRunId: runId,
  });
  await q(`UPDATE profiles SET page_state = 'live' WHERE id = $1`, [profileId]);
  // The deliberately misreported tip: the provider reports the wrong amount.
  const quote = await createQuote(database.db, {
    handle,
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  // As at a real checkout start: the attempt carries the provider's reference.
  await markAttemptInitiated(database.db, {
    attemptId,
    provider: 'mock',
    providerReference: `ref-${attemptId}`,
  });
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: `ref-${attemptId}`,
    amountMinor: 1n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: { kind: 'test' },
  });
  const raiseMismatch = async () => {
    const [alert] = await q(
      `SELECT event_type, dedupe_key, payload FROM outbox_events WHERE event_type = 'payment.mismatch'`,
    );
    await openIssueFromEvent(database.db, {
      eventType: alert.event_type,
      dedupeKey: alert.dedupe_key,
      payload: alert.payload,
    });
    const [issue] = await q(
      `SELECT id, status FROM issues WHERE kind = 'payment_mismatch'`,
    );
    return issue;
  };
  const checked = async () =>
    (
      await findAttemptsToReconcile(database.db, {
        olderThan: new Date(Date.now() + 60_000),
        limit: 50,
      })
    ).map((attempt) => attempt.attemptId);
  const issueStatus = async (id) =>
    (await q(`SELECT status FROM issues WHERE id = $1`, [id]))[0].status;
  return { database, runId, attemptId, raiseMismatch, checked, issueStatus };
}

test('after a release run finishes, its attempts are no longer re-checked', async (t) => {
  const { database, runId, attemptId, checked } = await rehearsal(
    t,
    'rehearsal_done',
  );
  // A real page's unfinished tip, alongside: it must keep being checked.
  const quote = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const real = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await markAttemptInitiated(database.db, {
    attemptId: real.attemptId,
    provider: 'mock',
    providerReference: `ref-${real.attemptId}`,
  });
  assert.ok((await checked()).includes(attemptId));
  await finishReleaseRun(database.db, { runId });
  const after = await checked();
  assert.ok(!after.includes(attemptId));
  assert.ok(after.includes(real.attemptId));
});

test('a rehearsal issue opened after its run finished is closed automatically', async (t) => {
  const { database, runId, raiseMismatch, issueStatus } = await rehearsal(
    t,
    'rehearsal_late',
  );
  await finishReleaseRun(database.db, { runId });
  const issue = await raiseMismatch();
  assert.equal(issue.status, 'open');
  const { resolved } = await autoResolveIssues(database.db, new Date());
  assert.ok(resolved >= 1);
  assert.equal(await issueStatus(issue.id), 'resolved');
});

test('a run that never finished keeps its issues and checks (Review Focus 1 and 5)', async (t) => {
  const { database, attemptId, raiseMismatch, checked, issueStatus } =
    await rehearsal(t, 'rehearsal_open');
  const issue = await raiseMismatch();
  await autoResolveIssues(database.db, new Date());
  assert.equal(await issueStatus(issue.id), 'open');
  assert.ok((await checked()).includes(attemptId));
});
