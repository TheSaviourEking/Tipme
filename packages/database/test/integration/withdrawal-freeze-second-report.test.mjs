import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  freezeWithdrawals,
  holdWithdrawals,
  openIssue,
  resolveIssue,
  withdrawalFreezeIssue,
  withdrawalsFrozen,
} from '../../dist/index.js';
import { TOBI, useDatabase } from './helpers.mjs';

const STAFF = '00000000-0000-7000-8000-00000000abcd';
const REASON = 'Checked it with the owner by phone.';
const REPORT = 'A new caller says the account was taken again.';

async function setup(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const { db, pool } = database;
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const report = (reason = REPORT) =>
    freezeWithdrawals(db, { profileId: TOBI, staffUserId: STAFF, reason });
  const secure = (issueId) =>
    resolveIssue(db, {
      issueId,
      staffUserId: STAFF,
      reason: REASON,
      outcome: 'account_secured',
      bankAndSignInChecked: true,
    });
  const close = (issueId) =>
    resolveIssue(db, {
      issueId,
      staffUserId: STAFF,
      reason: REASON,
      outcome: 'resolved_by_provider',
    });
  const reversal = async () => {
    const { id } = await openIssue(db, {
      dedupeKey: `event.payment.reversed.${randomUUID()}`,
      kind: 'payment_reversed',
      subject: { profileId: TOBI },
      now: new Date(),
    });
    await db.transaction((tx) =>
      holdWithdrawals(tx, {
        profileId: TOBI,
        reason: 'reversal',
        issueId: id,
      }),
    );
    return id;
  };
  const frozen = () => withdrawalsFrozen(db, { profileId: TOBI });
  const activeTakeover = () =>
    q(
      `SELECT issue_id FROM withdrawal_holds
        WHERE reason = 'account_takeover' AND released_at IS NULL`,
    );
  const openTakeovers = () =>
    q(
      `SELECT id FROM issues
        WHERE kind = 'account_takeover_reported' AND status = 'open'`,
    );
  const audits = (action) =>
    q(
      `SELECT reason FROM audit_events WHERE action = $1 AND subject_id = $2
        ORDER BY seq`,
      [action, TOBI],
    );
  const alerts = () =>
    q(
      `SELECT payload FROM outbox_events WHERE event_type = 'withdrawals.freeze_opened'
        ORDER BY created_at, id`,
    );
  /** Holds the profile lock, so each caller stops at its own turn for it. */
  let unlockProfile = async () => {};
  const lockProfile = async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM profiles WHERE id = $1 FOR UPDATE', [
      TOBI,
    ]);
    unlockProfile = async () => {
      unlockProfile = async () => {};
      await client.query('COMMIT');
      client.release();
    };
    return () => unlockProfile();
  };
  const waiting = async (count) => {
    for (let tries = 0; tries < 500; tries += 1) {
      const [row] = await q(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (row.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Let go first, so a failure here doesn't leave everything else waiting for ever.
    await unlockProfile();
    assert.fail(`never saw ${count} waiting on a lock`);
  };
  return {
    db,
    q,
    report,
    secure,
    close,
    reversal,
    frozen,
    activeTakeover,
    openTakeovers,
    audits,
    alerts,
    lockProfile,
    waiting,
  };
}

test('C1: a new report after the last closed opens an issue that alone can lift the freeze', async (t) => {
  const s = await setup(t);
  // 1. Frozen, with a reversal open too.
  const first = await s.report('The first report.');
  assert.equal(first.state, 'frozen');
  const other = await s.reversal();

  // 2. The takeover closes as secured: the reversal keeps everything held, by design.
  await s.secure(first.issueId);
  assert.equal(await s.frozen(), true);
  assert.deepEqual(await s.activeTakeover(), [{ issue_id: first.issueId }]);
  assert.match(
    (await s.audits('withdrawals.still_held'))[0].reason,
    /payment_reversed/,
  );

  // 3. A new theft is reported: a new issue to work, and the hold is tied to it.
  const second = await s.report();
  assert.equal(second.state, 'frozen');
  assert.notEqual(second.issueId, first.issueId);
  assert.deepEqual(await s.openTakeovers(), [{ id: second.issueId }]);
  assert.deepEqual(await s.activeTakeover(), [{ issue_id: second.issueId }]);
  assert.equal(
    await withdrawalFreezeIssue(s.db, { profileId: TOBI }),
    second.issueId,
  );
  const frozenAudit = await s.audits('withdrawals.frozen');
  assert.equal(frozenAudit.at(-1).reason, REPORT);
  const moved = await s.audits('withdrawals.freeze_reopened');
  assert.equal(moved.length, 1);
  assert.ok(moved[0].reason.includes(first.issueId));
  assert.ok(moved[0].reason.includes(second.issueId));
  assert.equal((await s.audits('withdrawals.freeze_reported_again')).length, 0);
  const [{ summary }] = await s.q('SELECT summary FROM issues WHERE id = $1', [
    second.issueId,
  ]);
  assert.ok(summary.includes(first.issueId), 'staff can find the earlier case');
  assert.ok(!summary.includes(REPORT), 'written reason stays in the audit log');

  // 4. The unrelated issue closing no longer lifts it.
  const releasedBefore = (await s.audits('withdrawals.released')).length;
  await s.close(other);
  assert.equal(await s.frozen(), true);
  assert.deepEqual(await s.activeTakeover(), [{ issue_id: second.issueId }]);
  assert.equal((await s.audits('withdrawals.released')).length, releasedBefore);

  // 5. Reported again while it is open: the same case.
  assert.deepEqual(await s.report('Yet another caller.'), {
    state: 'already_frozen',
    issueId: second.issueId,
  });
  assert.equal((await s.audits('withdrawals.freeze_reported_again')).length, 1);
  assert.deepEqual(await s.openTakeovers(), [{ id: second.issueId }]);

  // 6. Only that issue closing as secured releases it.
  await s.secure(second.issueId);
  assert.equal(await s.frozen(), false);
  assert.deepEqual(await s.activeTakeover(), []);
  const [hold] = await s.q(
    `SELECT count(*)::int AS active FROM withdrawal_holds WHERE released_at IS NULL`,
  );
  assert.equal(hold.active, 0);
});

test('a cause closed with another hold issue open behaves as designed, step by step', async (t) => {
  const s = await setup(t);
  const { issueId } = await s.report();
  const other = await s.reversal();
  await s.secure(issueId);
  // Held, by the reversal; the row still names the closed takeover, and the bank stays locked.
  assert.equal(await s.frozen(), true);
  assert.deepEqual(await s.activeTakeover(), [{ issue_id: issueId }]);
  assert.deepEqual(await s.openTakeovers(), []);
  // With no new report, the last issue closing ends it.
  await s.close(other);
  assert.equal(await s.frozen(), false);
  assert.equal((await s.audits('withdrawals.released')).length, 1);
});

test('the new report closing as secured while another hold issue is open waits for that too', async (t) => {
  const s = await setup(t);
  const first = await s.report();
  const other = await s.reversal();
  await s.secure(first.issueId);
  const second = await s.report();
  await s.secure(second.issueId);
  assert.equal(await s.frozen(), true);
  await s.close(other);
  assert.equal(await s.frozen(), false);
});

test('an unrelated money issue closing never lifts a hold whose takeover is open', async (t) => {
  const s = await setup(t);
  const first = await s.report();
  const other = await s.reversal();
  await s.secure(first.issueId);
  await s.report();
  const { id: failed } = await openIssue(s.db, {
    dedupeKey: `event.payout.failed.${randomUUID()}`,
    kind: 'payout_failed',
    subject: { profileId: TOBI },
    now: new Date(),
  });
  for (const issueId of [failed, other]) {
    await s.close(issueId);
    assert.equal(await s.frozen(), true);
  }
});

test('a row already naming a closed issue is handled on the next report, however it closed', async (t) => {
  for (const outcome of ['account_secured', null]) {
    const s = await setup(t);
    const { issueId: old } = await s.report();
    // As production may hold it today, written straight to the table.
    await s.q(
      `UPDATE issues SET status = 'resolved', resolved_at = now(), resolved_by = 'system',
         resolution_outcome = $2 WHERE id = $1`,
      [old, outcome],
    );
    assert.equal(await s.frozen(), true);
    const next = await s.report();
    assert.equal(next.state, 'frozen');
    assert.notEqual(next.issueId, old);
    assert.deepEqual(await s.activeTakeover(), [{ issue_id: next.issueId }]);
    assert.deepEqual(await s.openTakeovers(), [{ id: next.issueId }]);
    // The old row is ended, never left to be released later by something else.
    const [row] = await s.q(
      'SELECT released_at, released_by FROM withdrawal_holds WHERE issue_id = $1',
      [old],
    );
    assert.ok(row.released_at);
    assert.equal(row.released_by, STAFF);
    await s.secure(next.issueId);
    assert.equal(await s.frozen(), false);
  }
});

test('staff are alerted once per new issue, with ids only', async (t) => {
  const s = await setup(t);
  const first = await s.report('Secret words from the first caller.');
  assert.deepEqual(await s.alerts(), [
    { payload: { issueId: first.issueId, profileId: TOBI } },
  ]);
  await s.report('A repeat, on the same open issue.');
  assert.equal((await s.alerts()).length, 1);
  const other = await s.reversal();
  await s.secure(first.issueId);
  const second = await s.report('Secret words from the second caller.');
  const alerts = await s.alerts();
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[1].payload, {
    issueId: second.issueId,
    profileId: TOBI,
  });
  assert.ok(!JSON.stringify(alerts).includes('Secret words'));
  await s.close(other);
});

test('concurrent reports after the last closed make one issue, one hold and one alert', async (t) => {
  const s = await setup(t);
  const first = await s.report();
  await s.reversal();
  await s.secure(first.issueId);
  const answers = await Promise.all(
    Array.from({ length: 6 }, () => s.report()),
  );
  const fresh = answers.filter(({ state }) => state === 'frozen');
  assert.equal(fresh.length, 1);
  assert.equal(new Set(answers.map(({ issueId }) => issueId)).size, 1);
  assert.notEqual(fresh[0].issueId, first.issueId);
  assert.deepEqual(await s.openTakeovers(), [{ id: fresh[0].issueId }]);
  assert.deepEqual(await s.activeTakeover(), [{ issue_id: fresh[0].issueId }]);
  assert.equal((await s.alerts()).length, 2);
});

test('concurrent first reports make one issue and one hold', async (t) => {
  const s = await setup(t);
  const answers = await Promise.all(
    Array.from({ length: 6 }, () => s.report()),
  );
  assert.equal(answers.filter(({ state }) => state === 'frozen').length, 1);
  assert.equal(new Set(answers.map(({ issueId }) => issueId)).size, 1);
  assert.equal((await s.activeTakeover()).length, 1);
});

test('race: the takeover closes first, its transaction ahead of a report in the lock queue', async (t) => {
  const s = await setup(t);
  const { issueId } = await s.report();
  const unlock = await s.lockProfile();
  // Its issue row is updated, not committed; it waits for the profile.
  const closing = s.secure(issueId);
  await s.waiting(1);
  const reporting = s.report();
  await s.waiting(2);
  await unlock();
  await closing;
  const answer = await reporting;
  assert.equal(answer.state, 'frozen');
  assert.notEqual(answer.issueId, issueId);
  assert.equal(await s.frozen(), true);
  assert.deepEqual(await s.activeTakeover(), [{ issue_id: answer.issueId }]);
  assert.deepEqual(await s.openTakeovers(), [{ id: answer.issueId }]);
});

test('race: a report ahead of a close in the queue is already_frozen, then that close ends it, in that order', async (t) => {
  const s = await setup(t);
  const { issueId } = await s.report();
  const unlock = await s.lockProfile();
  const reporting = s.report();
  await s.waiting(1);
  const closing = s.secure(issueId);
  await s.waiting(2);
  await unlock();
  // Takes the profile lock before the close commits, so it sees the issue open: the close still
  // ends the freeze after. The report's reason is in the audit log.
  assert.deepEqual(await reporting, { state: 'already_frozen', issueId });
  await closing;
  assert.equal(await s.frozen(), false);
  assert.equal((await s.audits('withdrawals.freeze_reported_again')).length, 1);
  // Never a stranded state: the next report opens a new issue and freezes.
  const next = await s.report();
  assert.equal(next.state, 'frozen');
  assert.equal(await s.frozen(), true);
});

test('race: a new report and the unrelated issue closing, either way round, ends frozen on an open issue', async (t) => {
  for (const reportFirst of [true, false]) {
    const s = await setup(t);
    const first = await s.report();
    const other = await s.reversal();
    await s.secure(first.issueId);
    const unlock = await s.lockProfile();
    const a = reportFirst ? s.report() : s.close(other);
    await s.waiting(1);
    const b = reportFirst ? s.close(other) : s.report();
    await s.waiting(2);
    await unlock();
    const [one, two] = await Promise.all([a, b]);
    const answer = reportFirst ? one : two;
    assert.equal(answer.state, 'frozen');
    assert.notEqual(answer.issueId, first.issueId);
    assert.equal(await s.frozen(), true, `reportFirst=${reportFirst}`);
    assert.deepEqual(await s.activeTakeover(), [{ issue_id: answer.issueId }]);
    assert.deepEqual(await s.openTakeovers(), [{ id: answer.issueId }]);
  }
});
