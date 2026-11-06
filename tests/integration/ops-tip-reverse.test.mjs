import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';
import { GROSS, NET, reportedReversal } from './reversal-fixtures.mjs';

/*
 * Business release 2, PR R2-A Task 29: staff reverse a refunded or charged-back tip from the
 * partner's `payment_reversed` issue (Q7), as the serious action `tip.reverse`. Here one owner, so
 * it runs alone with the alert; ops-serious-gating and ops-serious-routes prove it waits for a
 * second person when one qualifies.
 */

const REASON = 'Checked the refund in the partner dashboard today';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let off;
let owner;
let ownerId;

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  const env = {
    WEB_ORIGIN: WEB,
    RATE_LIMIT_AUTH_PER_HOUR: '1000',
    RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
  };
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      ...env,
      BUSINESS_ENABLED: 'true',
      BUSINESS_SHARES_ENABLED: 'true',
    },
  });
  off = await startStack({ databaseUrl: database.url, apiEnv: env });
  owner = await opsSignIn(stack.api, database.db, '+2348037770101');
  [{ id: ownerId }] = await q(`SELECT id FROM users WHERE phone_e164 = $1`, [
    '+2348037770101',
  ]);
});
after(async () => {
  await off?.stop();
  await stack?.stop();
  await database?.close();
});
beforeEach(async () => {
  await q(`UPDATE ops_sessions SET last_totp_at = now()`);
  await q(`UPDATE staff SET role_id = 'owner' WHERE user_id = $1`, [ownerId]);
});

const reverse = (issueId, body, base = stack.api, cookie = owner.cookie) =>
  fetch(`${base}/v1/ops/issues/${issueId}/reverse-tip`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify(body),
  });
const full = {
  reason: REASON,
  refundedMinor: GROSS.toString(),
  dashboardVerified: true,
};
const person = async (profileId) =>
  (await ops.balanceOf(database.db, profileId)).availableMinor;
const business = async (businessId) =>
  (await ops.businessBalanceIn(database.db, businessId)).availableMinor;

test('staff reverse a shared tip: both parts come back, audited, alone with the alert', async () => {
  const before = await reportedReversal(database, { bps: 1000 });
  const personBefore = await person(before.profileId);
  assert.equal(await business(before.businessId), 36000n);
  const response = await reverse(before.issueId, full);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).data, {
    reversed: true,
    posted: true,
    belowZero: false,
    actedAlone: true,
  });
  assert.equal(await person(before.profileId), personBefore - (NET - 36000n));
  assert.equal(await business(before.businessId), 0n);
  assert.equal(await before.reversals(), 1);
  const audits = await q(
    `SELECT action, reason FROM audit_events WHERE action = 'serious_action.ran_alone'
      AND staff_user_id = $1 ORDER BY seq DESC LIMIT 1`,
    [ownerId],
  );
  assert.equal(audits.length, 1);
  assert.ok(audits[0].reason.startsWith(REASON));
  assert.match(audits[0].reason, /"action":"tip\.reverse"/);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length > 0,
    true,
  );
  // The same event again posts nothing more.
  const again = await reverse(before.issueId, full);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await again.json()).data.posted, false);
  assert.equal(await before.reversals(), 1);
});

test('a later chargeback for more than is left is refused, and the issue says why', async () => {
  const first = await reportedReversal(database);
  const half = await reverse(first.issueId, {
    ...full,
    refundedMinor: (GROSS / 2n).toString(),
  });
  assert.equal(half.status, 200, await half.clone().text());
  // The partner reports a chargeback on the same tip: a new event, so a new issue.
  const [{ attempt_id: attemptId }] = await q(
    `SELECT a.id AS attempt_id FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
      WHERE t.id = $1`,
    [first.tipId],
  );
  const eventId = `evt_chargeback_${randomUUID()}`;
  await ops.flagPaymentReversal(database.db, {
    attemptId,
    eventId,
    eventType: 'dispute.created',
  });
  const [{ id: chargeback }] = await q(
    `SELECT id FROM issues WHERE dedupe_key = $1`,
    [`event.payment.reversed.${attemptId}.${eventId}`],
  );
  const refused = await reverse(chargeback, full);
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal((await refused.json()).error.code, 'TIP_NOT_REVERSIBLE');
  assert.equal(await first.reversals(), 1);
  const notes = await q(`SELECT text FROM issue_notes WHERE issue_id = $1`, [
    chargeback,
  ]);
  assert.equal(notes.length, 1);
  assert.match(
    notes[0].text,
    /^Reversal refused: the amount is more than what is left/,
  );
  // What is left can be reversed.
  const rest = await reverse(chargeback, {
    ...full,
    refundedMinor: (GROSS / 2n).toString(),
  });
  assert.equal(rest.status, 200, await rest.clone().text());
  assert.equal(await first.reversals(), 2);
});

test('it needs payments.repair, a fresh code, a reason and the dashboard check', async () => {
  const target = await reportedReversal(database);
  const role = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [role]);
  for (const permission of ['issues.view', 'issues.resolve', 'payouts.resolve'])
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [role, permission],
    );
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [ownerId, role]);
  const noPermission = await reverse(target.issueId, full);
  assert.equal(noPermission.status, 403);
  await q(`UPDATE staff SET role_id = 'owner' WHERE user_id = $1`, [ownerId]);

  for (const body of [
    { refundedMinor: GROSS.toString(), dashboardVerified: true },
    { ...full, reason: 'short' },
    { reason: REASON, refundedMinor: GROSS.toString() },
    { ...full, refundedMinor: '0' },
    { ...full, refundedMinor: '-5' },
  ]) {
    const bad = await reverse(target.issueId, body);
    assert.equal(bad.status, 400, JSON.stringify(body));
  }

  await q(`UPDATE ops_sessions SET last_totp_at = now() - interval '1 hour'`);
  const stale = await reverse(target.issueId, full);
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).error.code, 'FRESH_CODE_REQUIRED');
  await q(`UPDATE ops_sessions SET last_totp_at = now()`);
  assert.equal(await target.reversals(), 0);
});

test('only from an open payment_reversed issue, and off without the flags', async () => {
  const target = await reportedReversal(database);
  const other = await ops.openIssue(database.db, {
    dedupeKey: `stuck_tip.${randomUUID()}`,
    kind: 'stuck_tip',
    subject: { tipId: target.tipId },
    now: new Date(),
  });
  assert.equal((await reverse(other.id, full)).status, 404);
  assert.equal((await reverse(randomUUID(), full)).status, 404);
  const flagsOff = await reverse(target.issueId, full, off.api);
  assert.equal(flagsOff.status, 404);
  assert.equal(await target.reversals(), 0);
});
