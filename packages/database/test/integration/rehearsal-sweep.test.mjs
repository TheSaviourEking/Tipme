import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  claimHandle,
  createPaymentIntent,
  createQuote,
  mailSealing,
  openReleaseRun,
  recordProviderEvent,
  sweepRehearsals,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// The worker's sweep of what release checks leave behind (31 Oct 2026): a run that crashed
// before its own clean-up leaves a live, tagged page and an account. After a grace period the
// sweep erases them through the normal deletion and finishes the run. Real pages are never
// touched, and nothing is booked or unbooked: ledger, history and audit stay as written.

const sealing = mailSealing(Buffer.alloc(32, 7));
const HOUR = 3_600_000;

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  const recipient = async (handle, rehearsalRunId) => {
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, email_verified_at) VALUES ($1, $2, now())`,
      [userId, `r@${handle}.example`],
    );
    const { profileId } = await claimHandle(database.db, {
      userId,
      handle,
      ...(rehearsalRunId ? { rehearsalRunId } : {}),
    });
    await q(`UPDATE profiles SET page_state = 'live' WHERE id = $1`, [
      profileId,
    ]);
    return { userId, profileId };
  };
  const paidTip = async (handle) => {
    const quote = await createQuote(database.db, {
      handle,
      tipMinor: 100000n,
      currency: 'NGN',
    });
    const { attemptId } = await createPaymentIntent(database.db, {
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
      amountMinor: BigInt(total),
      currency: 'NGN',
      providerFeeMinor: 1500n,
      signatureVerified: true,
      payload: {},
    });
  };
  /** Makes a page (and its run) look `hours` old. */
  const age = async (profileId, hours) => {
    await q(
      `UPDATE profiles SET created_at = now() - make_interval(hours => $2) WHERE id = $1`,
      [profileId, hours],
    );
    await q(
      `UPDATE release_runs SET created_at = now() - make_interval(hours => $2)
        WHERE id = (SELECT rehearsal_run_id FROM profiles WHERE id = $1)`,
      [profileId, hours],
    );
  };
  return { ...database, q, recipient, paidTip, age };
}

test('a rehearsal left behind is erased after the grace period, money and all, and its run finished', async (t) => {
  const { db, q, recipient, paidTip, age } = await fresh(t);
  const { runId } = await openReleaseRun(db);
  const { userId, profileId } = await recipient('rc_leftover', runId);
  await paidTip('rc_leftover');
  await age(profileId, 3);
  const ledgerBefore = (
    await q('SELECT count(*)::int AS n FROM ledger_entries')
  )[0].n;

  const result = await sweepRehearsals(db, { sealing, olderThanMs: 2 * HOUR });
  assert.deepEqual(result, { erased: 1, runsFinished: 1 });

  const [page] = await q('SELECT page_state FROM profiles WHERE id = $1', [
    profileId,
  ]);
  assert.equal(page.page_state, 'deleted');
  const [user] = await q(
    'SELECT email, deleted_at IS NOT NULL AS gone FROM users WHERE id = $1',
    [userId],
  );
  assert.equal(user.email, null);
  assert.equal(user.gone, true);
  const [run] = await q(
    'SELECT finished_at IS NOT NULL AS done FROM release_runs WHERE id = $1',
    [runId],
  );
  assert.equal(run.done, true);
  // Nothing is unbooked, and nobody is emailed about a rehearsal.
  assert.equal(
    (await q('SELECT count(*)::int AS n FROM ledger_entries'))[0].n,
    ledgerBefore,
  );
  assert.equal(
    (
      await q(
        `SELECT count(*)::int AS n FROM mail_messages WHERE type = 'account_deleted_notice'`,
      )
    )[0].n,
    0,
  );
});

test('a rehearsal still inside the grace period is left alone (its check may still be running)', async (t) => {
  const { db, q, recipient } = await fresh(t);
  const { runId } = await openReleaseRun(db);
  const { profileId } = await recipient('rc_running', runId);
  assert.deepEqual(
    await sweepRehearsals(db, { sealing, olderThanMs: 2 * HOUR }),
    {
      erased: 0,
      runsFinished: 0,
    },
  );
  const [page] = await q('SELECT page_state FROM profiles WHERE id = $1', [
    profileId,
  ]);
  assert.equal(page.page_state, 'live');
});

test('real pages are never swept, however old, even with money on them', async (t) => {
  const { db, q, recipient, paidTip, age } = await fresh(t);
  const { profileId } = await recipient('real_person');
  await paidTip('real_person');
  await age(profileId, 24 * 30);
  assert.equal(
    (await sweepRehearsals(db, { sealing, olderThanMs: 2 * HOUR })).erased,
    0,
  );
  const [page] = await q('SELECT page_state FROM profiles WHERE id = $1', [
    profileId,
  ]);
  assert.equal(page.page_state, 'live');
});

test('a run that crashed before tagging anything is finished too', async (t) => {
  const { db, q } = await fresh(t);
  const { runId } = await openReleaseRun(db);
  await q(
    `UPDATE release_runs SET created_at = now() - interval '3 hours' WHERE id = $1`,
    [runId],
  );
  assert.deepEqual(
    await sweepRehearsals(db, { sealing, olderThanMs: 2 * HOUR }),
    {
      erased: 0,
      runsFinished: 1,
    },
  );
});

test('sweeping twice changes nothing more', async (t) => {
  const { db, recipient, age } = await fresh(t);
  const { runId } = await openReleaseRun(db);
  const { profileId } = await recipient('rc_twice', runId);
  await age(profileId, 3);
  await sweepRehearsals(db, { sealing, olderThanMs: 2 * HOUR });
  assert.deepEqual(
    await sweepRehearsals(db, { sealing, olderThanMs: 2 * HOUR }),
    {
      erased: 0,
      runsFinished: 0,
    },
  );
});
