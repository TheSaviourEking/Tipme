import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY, setSwitch } from './helpers.mjs';

/*
 * Staff "Refund tip" (owner, 14 Nov 2026): a written reason, a fresh code and a second person
 * (`tip.refund`, payments.repair). Approving only records the refund; the partner's refund.paid,
 * which repeats TipMe's reference, books it, and TipMe keeps its fee. Nothing reaches the network.
 */
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON =
  'The supporter paid twice by mistake and asked us to refund one.';
const [, TOBI] = ops.DEMO_PROFILES;
const GROSS = 1_000_000n;
// Free keeps 5% (owner, 18 Nov 2026): ₦9,500 of a ₦10,000 tip.
const NET = 950_000n;

let database;
const people = new Map();
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
  await setSwitch(database.pool, 'tip_refunds', true);
});
after(async () => {
  await database.close();
});
beforeEach(async () => {
  for (const table of [
    'ops_sessions',
    'staff_totp',
    'staff',
    'approval_requests',
    'tip_refunds',
  ])
    await q(`DELETE FROM ${table}`);
});

async function person() {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`tiprefund.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [id],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [id, ops.sealSecret(key, secret)],
  );
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [id, randomBytes(32).toString('hex')],
  );
  const [{ id: grantId }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [id, sessionId, randomBytes(32).toString('hex')],
  );
  people.set(id, { secret, grantId });
  return id;
}

const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});
const ask = (actorId, tipId) =>
  ops.requestSeriousAction(database.db, {
    name: 'tip.refund',
    payload: { tipId },
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
  });
const approve = (requestId, actorId) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: totpAt(
      people.get(actorId).secret,
      BigInt(Math.floor(Date.now() / 30_000)),
    ),
    key,
    services: services(),
  });

async function paidTip() {
  const { db } = database;
  const quote = await ops.createQuote(db, {
    handle: 'tobi',
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `mock_pay_${randomUUID()}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await ops.recordProviderEvent(db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: GROSS,
    currency: 'NGN',
    providerFeeMinor: 20000n,
    signatureVerified: true,
    payload: {},
  });
  return intent.tipId;
}

test('a tip refund waits for a second person and says what goes back; approving records it only', async () => {
  const requester = await person();
  const approver = await person();
  const tipId = await paidTip();
  const before = (await ops.balanceOf(database.db, TOBI.id)).availableMinor;
  const outcome = await ask(requester, tipId);
  assert.equal(outcome.state, 'pending');
  assert.equal((await q(`SELECT 1 FROM tip_refunds`)).length, 0);
  const [request] = await q(
    `SELECT summary FROM approval_requests WHERE id = $1`,
    [outcome.requestId],
  );
  assert.match(
    request.summary,
    /Refund NGN 9,500\.00 of a NGN 10,000\.00 tip to @tobi/,
  );
  assert.match(request.summary, /TipMe keeps its NGN 500\.00 fee/);
  // The one who asked can't decide it.
  await assert.rejects(approve(outcome.requestId, requester), {
    code: 'APPROVAL_OWN_REQUEST',
  });
  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  const [row] = await q(`SELECT * FROM tip_refunds`);
  assert.equal(row.status, 'REQUESTED');
  assert.equal(row.amount_minor, NET.toString());
  assert.equal(row.requested_by, requester);
  assert.equal(row.approved_by, approver);
  assert.equal(
    (await ops.balanceOf(database.db, TOBI.id)).availableMinor,
    before,
  );
});

// The `tip_refunds` switch is a money switch: turned off while a refund waits for its second
// person, the approval records nothing (as tip.reverse, review finding 3).
test('an approval after the tip_refunds switch went off records no refund', async () => {
  const requester = await person();
  const approver = await person();
  const tipId = await paidTip();
  const outcome = await ask(requester, tipId);
  assert.equal(outcome.state, 'pending');
  await setSwitch(database.pool, 'tip_refunds', false);
  try {
    const decided = await approve(outcome.requestId, approver);
    assert.equal(decided.status, 'stale', JSON.stringify(decided));
    assert.equal((await q(`SELECT 1 FROM tip_refunds`)).length, 0);
  } finally {
    await setSwitch(database.pool, 'tip_refunds', true);
  }
});

test('the partner’s refund.paid repeating TipMe’s reference books the refund once; TipMe keeps its fee', async () => {
  const requester = await person();
  const approver = await person();
  const tipId = await paidTip();
  const outcome = await ask(requester, tipId);
  await approve(outcome.requestId, approver);
  const [{ id }] = await q(`SELECT id FROM tip_refunds`);
  const service = new WebhookService({ db: database.db }, sealing, {
    warn() {},
  });
  const event = (refundState) => ({
    kind: 'reversal',
    eventId: `evt_${randomUUID()}`,
    eventType: `refund.${refundState === 'pending' ? 'created' : refundState}`,
    accountReference: 'acct_tobi',
    providerReference: null,
    operationReference: `tipme-tip-refund-${id}`,
    partnerReversalId: 'refund.rfnd_x',
    disputeWon: false,
    refundState,
    refundedMinor: refundState === 'paid' ? NET : null,
    refundFeeMinor: refundState === 'paid' ? 0n : null,
  });
  const provider = { environment: 'sandbox' };
  assert.equal(
    await service.applyBachs(event('pending'), provider),
    'tip_refund_noted',
  );
  assert.equal(
    await service.applyBachs(event('paid'), provider),
    'tip_refund_refunded',
  );
  assert.equal(
    await service.applyBachs(event('paid'), provider),
    'tip_refund_already',
  );
  assert.equal((await q(`SELECT status FROM tip_refunds`))[0].status, 'PAID');
  // Not unmatched, and not a staff money issue: TipMe asked for this one.
  assert.equal((await q(`SELECT 1 FROM unmatched_provider_events`)).length, 0);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM issues WHERE kind = 'payment_reversed' AND subject->>'tipId' = $1`,
        [tipId],
      )
    ).length,
    0,
  );
  const [kept] = await q(
    `SELECT COALESCE(SUM(CASE e.side WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS net
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions x ON x.id = e.transaction_id
      WHERE x.tip_id = $1 AND a.code IN ('platform_fee_revenue', 'provider_fee_recovered')`,
    [tipId],
  );
  assert.equal(kept.net, (GROSS - NET).toString());
});
