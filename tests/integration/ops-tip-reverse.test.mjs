import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { totpAt } from '../../packages/domain/dist/index.js';
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
  assert.equal(await business(before.businessId), 37200n);
  const response = await reverse(before.issueId, full);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).data, {
    reversed: true,
    posted: true,
    belowZero: false,
    actedAlone: true,
  });
  assert.equal(await person(before.profileId), personBefore - (NET - 37200n));
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
  // The same refund again is refused, posts nothing, and the issue says why.
  const again = await reverse(before.issueId, full);
  assert.equal(again.status, 409, await again.clone().text());
  assert.equal((await again.json()).error.code, 'TIP_NOT_REVERSIBLE');
  assert.equal(await before.reversals(), 1);
  const notes = await q(`SELECT text FROM issue_notes WHERE issue_id = $1`, [
    before.issueId,
  ]);
  assert.match(
    notes.at(-1).text,
    /^Reversal refused: this refund or dispute was already reversed/,
  );
});

test('two webhook events for one ₦500 refund reverse exactly ₦500', async () => {
  // Accepted, then paid: two events about one ₦500 refund.
  const target = await reportedReversal(database, {
    events: ['refund.created', 'refund.paid'],
    refundedMinor: 50000n,
  });
  const issues = await q(
    `SELECT id FROM issues WHERE kind = 'payment_reversed' AND subject->>'tipId' = $1`,
    [target.tipId],
  );
  assert.deepEqual(issues, [{ id: target.issueId }]);
  const fiveHundred = { ...full, refundedMinor: '50000' };
  const first = await reverse(target.issueId, fiveHundred);
  assert.equal(first.status, 200, await first.clone().text());
  const second = await reverse(target.issueId, fiveHundred);
  assert.equal(second.status, 409, await second.clone().text());
  const [{ reversed }] = await q(
    `SELECT sum(e.amount_minor)::text AS reversed FROM ledger_entries e
       JOIN ledger_transactions x ON x.id = e.transaction_id
      WHERE x.tip_id = $1 AND x.operation_type = 'reversal' AND e.side = 'debit'`,
    [target.tipId],
  );
  assert.equal(reversed, '50000');
});

test('the approver sees earlier reversals, and an approval on a copy with the flags off still posts', async () => {
  const target = await reportedReversal(database, { refundedMinor: 100000n });
  // An earlier refund of this tip, already reversed (another partner refund).
  const earlierId = `refund.re_${randomUUID().replaceAll('-', '')}`;
  await ops.flagPaymentReversal(database.db, {
    attemptId: target.attemptId,
    eventId: `evt_${randomUUID()}`,
    eventType: 'refund.paid',
    partnerReversalId: earlierId,
    disputeWon: false,
    refundState: 'paid',
    refundedMinor: 50000n,
    refundFeeMinor: 0n,
  });
  const [{ id: earlierIssue }] = await q(
    `SELECT id FROM issues WHERE subject->>'partnerReversalId' = $1`,
    [earlierId],
  );
  const earlier = await reverse(earlierIssue, {
    ...full,
    refundedMinor: '50000',
  });
  assert.equal(earlier.status, 200, await earlier.clone().text());

  const second = await opsSignIn(stack.api, database.db, '+2348037770102');
  const [{ id: secondId }] = await q(
    `SELECT id FROM users WHERE phone_e164 = '+2348037770102'`,
  );
  try {
    const asked = await reverse(target.issueId, {
      ...full,
      refundedMinor: '100000',
    });
    assert.equal(asked.status, 202, await asked.clone().text());
    const { requestId } = (await asked.json()).data;
    const [{ summary }] = await q(
      `SELECT summary FROM approval_requests WHERE id = $1`,
      [requestId],
    );
    assert.match(
      summary,
      /Already taken back from this tip: NGN 500\.00 in 1 reversal/,
    );
    // The flags go off before the second person approves: it still posts (owner, 12 Nov 2026:
    // money the partner moved is never left without its posting; the flags gate shares only).
    await q(`UPDATE staff_totp SET last_step = NULL WHERE user_id = $1`, [
      secondId,
    ]);
    const approved = await fetch(
      `${off.api}/v1/ops/approvals/${requestId}/approve`,
      {
        method: 'POST',
        headers: browserHeaders(second.cookie),
        body: JSON.stringify({
          code: totpAt(second.secret, BigInt(Math.floor(Date.now() / 30_000))),
        }),
      },
    );
    assert.equal(approved.status, 200, await approved.clone().text());
    // The earlier refund's reversal, and now this one.
    assert.equal(await target.reversals(), 2);
    const [{ status }] = await q(
      `SELECT status FROM approval_requests WHERE id = $1`,
      [requestId],
    );
    assert.equal(status, 'approved');
  } finally {
    await q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [
      secondId,
    ]);
  }
});

test('a later chargeback for more than is left is refused, and the issue says why', async () => {
  const first = await reportedReversal(database, { refundedMinor: GROSS / 2n });
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
  const disputeId = `dispute.dp_${randomUUID().replaceAll('-', '')}`;
  await ops.flagPaymentReversal(database.db, {
    attemptId,
    eventId: `evt_chargeback_${randomUUID()}`,
    eventType: 'dispute.created',
    partnerReversalId: disputeId,
    disputeWon: false,
  });
  const [{ id: chargeback }] = await q(
    `SELECT id FROM issues WHERE dedupe_key = $1`,
    [`event.payment.reversed.${attemptId}.${disputeId}`],
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

test('only from an open payment_reversed issue, and with or without the release 2 flags', async () => {
  const target = await reportedReversal(database);
  const other = await ops.openIssue(database.db, {
    dedupeKey: `stuck_tip.${randomUUID()}`,
    kind: 'stuck_tip',
    subject: { tipId: target.tipId },
    now: new Date(),
  });
  assert.equal((await reverse(other.id, full)).status, 404);
  assert.equal((await reverse(randomUUID(), full)).status, 404);
  assert.equal(await target.reversals(), 0);
  // Owner, 12 Nov 2026: a refunded tip is reversed whatever the release 2 flags.
  const flagsOff = await reverse(target.issueId, full, off.api);
  assert.equal(flagsOff.status, 200, await flagsOff.clone().text());
  assert.equal(await target.reversals(), 1);
});

test("only a paid refund is reversed, for exactly what the partner gave back, and its fee is TipMe's", async () => {
  // Accepted but not paid yet: nothing to reverse.
  const pending = await reportedReversal(database, {
    events: ['refund.created'],
  });
  assert.equal((await reverse(pending.issueId, full)).status, 404);
  // Paid: staff must enter what the partner reports it gave back.
  const paid = await reportedReversal(database, {
    refundedMinor: 120000n,
    refundFeeMinor: 1500n,
  });
  const wrong = await reverse(paid.issueId, {
    ...full,
    refundedMinor: '100000',
  });
  assert.equal(wrong.status, 409, await wrong.clone().text());
  const notes = await q(`SELECT text FROM issue_notes WHERE issue_id = $1`, [
    paid.issueId,
  ]);
  assert.match(
    notes.at(-1).text,
    /^Reversal refused: the amount entered differs/,
  );
  assert.equal(await paid.reversals(), 0);
  const right = await reverse(paid.issueId, {
    ...full,
    refundedMinor: '120000',
  });
  assert.equal(right.status, 200, await right.clone().text());
  const [{ clearing, fee }] = await q(
    `SELECT sum(e.amount_minor) FILTER (WHERE a.code = 'provider_clearing')::text AS clearing,
            sum(e.amount_minor) FILTER (WHERE a.code = 'provider_fee_expense')::text AS fee
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions x ON x.id = e.transaction_id
      WHERE x.tip_id = $1 AND x.operation_type = 'reversal'`,
    [paid.tipId],
  );
  // The whole refund and its ₦15 fee leave the partner balance; the fee is TipMe's expense.
  assert.equal(clearing, '121500');
  assert.equal(fee, '1500');
});
