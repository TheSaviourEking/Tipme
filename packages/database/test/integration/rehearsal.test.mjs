import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  claimHandle,
  createPaymentIntent,
  createQuote,
  finishReleaseRun,
  grantOwner,
  healthMetrics,
  listIssues,
  openIssueFromEvent,
  openReleaseRun,
  recordClientEvent,
  recordProviderEvent,
  staffPermissions,
  visibilityMetrics,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

test('rehearsal runs', async (t) => {
  const database = await useDatabase(t);
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);

  /** A signed-up recipient with a live page, optionally tagged with a run. */
  const recipient = async (handle, rehearsalRunId) => {
    const userId = randomUUID();
    await q(`INSERT INTO users (id, phone_e164) VALUES ($1, $2)`, [
      userId,
      `+23480355${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`,
    ]);
    const { profileId } = await claimHandle(database.db, {
      userId,
      handle,
      rehearsalRunId,
    });
    await q(`UPDATE profiles SET page_state = 'live' WHERE id = $1`, [
      profileId,
    ]);
    return profileId;
  };
  const paidTip = async (handle, outcome = 'succeed') => {
    const quote = await createQuote(database.db, {
      handle,
      tipMinor: 100000n,
      currency: 'NGN',
    });
    const { tipId, attemptId } = await createPaymentIntent(database.db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const [{ total }] = await q(
      'SELECT payer_total_minor AS total FROM tip_quotes WHERE id = $1',
      [quote.quoteId],
    );
    await recordProviderEvent(database.db, {
      provider: 'mock',
      providerEventId: randomUUID(),
      eventType: 'payment.succeeded',
      attemptId,
      providerReference: `ref-${attemptId}`,
      amountMinor: outcome === 'wrong-amount' ? 1n : BigInt(total),
      currency: 'NGN',
      providerFeeMinor: 1500n,
      signatureVerified: true,
      payload: { kind: 'test' },
    });
    return { tipId, attemptId };
  };

  await t.test(
    'a rehearsal page and everything hanging off it stay out of metrics and the default inbox (Review Focus 3)',
    async () => {
      await database.fresh();
      const now = new Date();
      const before = await healthMetrics(database.db, { now });
      const { runId } = await openReleaseRun(database.db);
      const profileId = await recipient('rehearsal_one', runId);
      const [{ rehearsal_run_id: tagged }] = await q(
        'SELECT rehearsal_run_id FROM profiles WHERE id = $1',
        [profileId],
      );
      assert.equal(tagged, runId);
      await paidTip('rehearsal_one');
      const bad = await paidTip('rehearsal_one', 'wrong-amount');
      const [alert] = await q(
        `SELECT event_type, dedupe_key, payload FROM outbox_events WHERE event_type = 'payment.mismatch'`,
      );
      await openIssueFromEvent(database.db, {
        eventType: alert.event_type,
        dedupeKey: alert.dedupe_key,
        payload: alert.payload,
      });
      const flow = randomUUID();
      await recordClientEvent(database.db, {
        event: {
          name: 'profile_viewed',
          flowId: flow,
          handle: 'rehearsal_one',
          channel: 'qr',
        },
        device: 'mobile',
        now,
      });

      const after = await healthMetrics(database.db, { now });
      assert.deepEqual(after.money, before.money);
      assert.deepEqual(after.recipients, before.recipients);
      assert.deepEqual(after.funnel, before.funnel);
      assert.deepEqual(
        after.reliability.openIssues,
        before.reliability.openIssues,
      );
      const visibility = await visibilityMetrics(database.db, { now });
      assert.equal(visibility.visits, 0);
      assert.deepEqual(visibility.topPages, []);

      assert.equal(
        (await listIssues(database.db, { limit: 50 })).some(
          (i) => i.subject.tipId === bad.tipId,
        ),
        false,
        'hidden from the default inbox',
      );
      const shown = await listIssues(database.db, {
        limit: 50,
        includeRehearsal: true,
      });
      const issue = shown.find((i) => i.subject.tipId === bad.tipId);
      assert.ok(issue, 'shown on request');

      const { issuesClosed } = await finishReleaseRun(database.db, { runId });
      assert.equal(issuesClosed, 1);
      const [closed] = await q(
        'SELECT status, resolved_by FROM issues WHERE id = $1',
        [issue.id],
      );
      assert.deepEqual(closed, { status: 'resolved', resolved_by: 'system' });
      const [audit] = await q(
        `SELECT reason FROM audit_events WHERE action = 'issue.auto_resolved' AND subject_id = $1`,
        [issue.id],
      );
      assert.equal(audit.reason, 'release check');
      // The money trail is untouched: the ledger still holds the rehearsal booking.
      assert.ok(
        (
          await q(
            `SELECT count(*)::int AS n FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.profile_id = $1`,
            [profileId],
          )
        )[0].n > 0,
      );
    },
  );

  await t.test('an unknown or finished run never tags a page', async () => {
    await database.fresh();
    const unknown = await recipient('not_tagged_a', randomUUID());
    const { runId } = await openReleaseRun(database.db);
    await finishReleaseRun(database.db, { runId });
    const finished = await recipient('not_tagged_b', runId);
    const rows = await q(
      'SELECT rehearsal_run_id FROM profiles WHERE id = ANY($1)',
      [[unknown, finished]],
    );
    assert.deepEqual(
      rows.map((r) => r.rehearsal_run_id),
      [null, null],
    );
  });

  await t.test(
    'the release-check staff role holds exactly four permissions',
    async () => {
      await database.fresh();
      const { userId } = await grantOwner(database.db, {
        phone: '+2348035559001',
        role: 'release_check',
      });
      assert.deepEqual(
        [...(await staffPermissions(database.db, userId))].sort(),
        ['analytics.view', 'audit.view', 'issues.resolve', 'issues.view'],
      );
    },
  );
});
