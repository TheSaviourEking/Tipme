import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY } from './helpers.mjs';

/*
 * Paid Pro, plan Task 9 (ruling 6): staff refund a card-paid Pro month on the member's request,
 * within 14 days, with a second person (`pro.refund`). Bank-transfer and balance months can't be
 * refunded through the partner. Only `refund.paid` books it and ends that month; `refund.failed`
 * leaves Pro as it was. A pretend partner stands in: nothing here reaches the network.
 */
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Member asked by email on the day they paid';
const [ADA] = ops.DEMO_PROFILES;

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
    'outbox_events',
    'pro_refunds',
  ])
    await q(`DELETE FROM ${table}`);
  await q(
    `UPDATE profiles SET staff_pro = false, plan = 'free' WHERE id = $1`,
    [ADA.id],
  );
});

async function person() {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`refund.${randomUUID().slice(0, 8)}@example.com`],
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
const ask = (actorId, purchaseId) =>
  ops.requestSeriousAction(database.db, {
    name: 'pro.refund',
    payload: { purchaseId },
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

/** A Pro month paid now on TipMe's own account, by card (or bank transfer), through a fake partner. */
async function paidMonth(method = 'NGN_CARD') {
  await q(`DELETE FROM pro_periods WHERE profile_id = $1`, [ADA.id]);
  await q(
    `UPDATE pro_purchases SET status = 'FAILED' WHERE profile_id = $1 AND status IN ('PENDING','COLLECTING','UNKNOWN')`,
    [ADA.id],
  );
  const purchaseId = randomUUID();
  const bought = await ops.buyProByCheckout(database.db, {
    profileId: ADA.id,
    expectedAmountMinor: 250000n,
    idempotencyKey: randomUUID(),
    provider: {
      async initializePlatformCheckout() {
        return {
          providerReference: `platform:cs_${purchaseId}`,
          checkoutUrl: 'https://checkout.bachs.io/session/x',
          expiresAt: new Date(Date.now() + 30 * 60_000),
        };
      },
      async verifyTransaction() {
        throw new Error('not here');
      },
    },
    providerName: 'bachs',
    successUrl: 'https://usetipme.xyz/dashboard/settings',
    cancelUrl: 'https://usetipme.xyz/dashboard/settings',
    now: new Date(),
  });
  const done = await ops.confirmProCheckout(database.db, {
    purchaseId: bought.purchaseId,
    verified: {
      status: 'succeeded',
      amountMinor: 250000n,
      currency: 'NGN',
      feeMinor: 5000n,
      method,
      chargeReference: `ch_${purchaseId.slice(0, 8)}`,
    },
    now: new Date(),
    sealing,
  });
  assert.equal(done.outcome, 'paid');
  return bought.purchaseId;
}

/** The fake partner the worker's refund sender talks to. */
function partner(answer = 'processing') {
  const calls = [];
  return {
    calls,
    async refundPlatformCharge(input) {
      calls.push(input);
      if (answer === 'refused') {
        const error = new Error('refused');
        error.name = 'ProRefundRefusedError';
        throw error;
      }
      return { refundReference: 'rf_1', status: 'processing' };
    },
  };
}
const send = (provider) =>
  ops.sendProRefunds(database.db, {
    provider,
    providerName: 'bachs',
    now: new Date(),
  });
const event = (purchaseId, refundState, over = {}) =>
  ops.applyProRefundEvent(database.db, {
    purchaseId,
    eventRowId: randomUUID(),
    refundState,
    partnerRefundId: 'refund.rf_1',
    operationReference: null,
    refundedMinor: refundState === 'paid' ? 250000n : null,
    refundFeeMinor: refundState === 'paid' ? 0n : null,
    now: new Date(),
    ...over,
  });
const planOf = async () =>
  (await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA.id]))[0].plan;
const refundLedger = (purchaseId) =>
  q(
    `SELECT a.code, e.side, e.amount_minor FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.operation_key = $1 ORDER BY a.code`,
    [`pro_refund.${purchaseId}`],
  );
const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return [error.code, error.detail].filter(Boolean).join(':');
  }
};

test('a card month refund waits for a second person, then is sent to the partner once', async () => {
  const requester = await person();
  const approver = await person();
  const purchaseId = await paidMonth();
  const outcome = await ask(requester, purchaseId);
  assert.equal(outcome.state, 'pending');
  assert.equal((await q(`SELECT 1 FROM pro_refunds`)).length, 0);
  const [request] = await q(
    `SELECT summary FROM approval_requests WHERE id = $1`,
    [outcome.requestId],
  );
  assert.match(request.summary, /Refund .*NGN 2,500\.00/);
  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  const [row] = await q(`SELECT * FROM pro_refunds`);
  assert.equal(row.status, 'REQUESTED');
  assert.equal(row.requested_by, requester);
  assert.equal(row.approved_by, approver);
  // Approving moves no money and changes no plan: the worker sends it, the partner decides.
  assert.equal(await planOf(), 'pro');
  const fake = partner();
  await send(fake);
  await send(fake);
  assert.equal(fake.calls.length, 1);
  const [purchase] = await q(
    `SELECT charge_reference FROM pro_purchases WHERE id = $1`,
    [purchaseId],
  );
  assert.match(purchase.charge_reference, /^ch_/);
  assert.equal(fake.calls[0].chargeReference, purchase.charge_reference);
  assert.equal(fake.calls[0].amountMinor, 250000n);
  assert.equal(fake.calls[0].idempotencyKey, `tipme-pro-refund-${row.id}`);
  assert.equal(
    (await q(`SELECT status FROM pro_refunds`))[0].status,
    'PROCESSING',
  );
  assert.equal(await planOf(), 'pro');
});

test('refund.paid books the reversal once, ends that month at once and the page goes free', async () => {
  const requester = await person();
  const approver = await person();
  const purchaseId = await paidMonth();
  const outcome = await ask(requester, purchaseId);
  await approve(outcome.requestId, approver);
  await send(partner());
  await event(purchaseId, 'pending');
  assert.equal(await planOf(), 'pro');
  await event(purchaseId, 'paid');
  await event(purchaseId, 'paid');
  assert.equal((await q(`SELECT status FROM pro_refunds`))[0].status, 'PAID');
  assert.deepEqual(
    (await refundLedger(purchaseId)).map((l) => [
      l.code,
      l.side,
      l.amount_minor,
    ]),
    [
      ['platform_clearing', 'credit', '250000'],
      ['subscription_revenue', 'debit', '250000'],
    ],
  );
  assert.equal(await planOf(), 'free');
  const [period] = await q(
    `SELECT status FROM pro_periods WHERE purchase_id = $1`,
    [purchaseId],
  );
  assert.equal(period.status, 'ENDED');
});

test('a staff grant keeps Pro on after the refund ends the paid month', async () => {
  const requester = await person();
  const approver = await person();
  const purchaseId = await paidMonth();
  await q(`UPDATE profiles SET staff_pro = true WHERE id = $1`, [ADA.id]);
  const outcome = await ask(requester, purchaseId);
  await approve(outcome.requestId, approver);
  await send(partner());
  await event(purchaseId, 'paid');
  assert.equal(await planOf(), 'pro');
});

test('refund.failed keeps Pro, books nothing and opens a money issue; it can be asked again', async () => {
  const requester = await person();
  const approver = await person();
  const purchaseId = await paidMonth();
  const outcome = await ask(requester, purchaseId);
  await approve(outcome.requestId, approver);
  await send(partner());
  await event(purchaseId, 'failed');
  assert.equal((await q(`SELECT status FROM pro_refunds`))[0].status, 'FAILED');
  assert.equal(await planOf(), 'pro');
  assert.equal((await refundLedger(purchaseId)).length, 0);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'pro.refund_failed'`,
      )
    ).length,
    1,
  );
  // A failed refund doesn't count (the partner's guide): staff may ask again.
  assert.equal((await ask(requester, purchaseId)).state, 'pending');
});

test('a partner refusal fails the refund and leaves Pro', async () => {
  const requester = await person();
  const approver = await person();
  const purchaseId = await paidMonth();
  const outcome = await ask(requester, purchaseId);
  await approve(outcome.requestId, approver);
  await send(partner('refused'));
  assert.equal((await q(`SELECT status FROM pro_refunds`))[0].status, 'FAILED');
  assert.equal(await planOf(), 'pro');
});

test('outside 14 days of payment is refused', async () => {
  const requester = await person();
  await person();
  const purchaseId = await paidMonth();
  await q(
    `UPDATE pro_purchases SET paid_at = now() - interval '15 days' WHERE id = $1`,
    [purchaseId],
  );
  assert.equal(
    await codeOf(ask(requester, purchaseId)),
    'PRO_REFUND_REFUSED:too_late',
  );
});

test('a bank-transfer month is refused, and staff are told it can’t be refunded through the partner', async () => {
  const requester = await person();
  await person();
  const purchaseId = await paidMonth('NGN_BANK_TRANSFER');
  assert.equal(
    await codeOf(ask(requester, purchaseId)),
    'PRO_REFUND_REFUSED:bank_transfer',
  );
  const facts = await ops.proRefundFacts(database.db, purchaseId, new Date());
  assert.equal(facts.refundable, false);
  assert.match(facts.words, /can’t be refunded through our payment partner/);
});

test('a balance month is refused', async () => {
  const requester = await person();
  await person();
  const purchaseId = await paidMonth();
  await q(`UPDATE pro_purchases SET method = 'balance' WHERE id = $1`, [
    purchaseId,
  ]);
  await q(`UPDATE pro_periods SET paid_by = 'balance' WHERE purchase_id = $1`, [
    purchaseId,
  ]);
  assert.equal(
    await codeOf(ask(requester, purchaseId)),
    'PRO_REFUND_REFUSED:balance',
  );
});

test('a second refund while one is in progress is refused', async () => {
  const requester = await person();
  const approver = await person();
  const purchaseId = await paidMonth();
  const outcome = await ask(requester, purchaseId);
  await approve(outcome.requestId, approver);
  assert.equal(
    await codeOf(ask(requester, purchaseId)),
    'PRO_REFUND_REFUSED:already',
  );
});

test('an unknown purchase is not refundable', async () => {
  const facts = await ops.proRefundFacts(database.db, randomUUID(), new Date());
  assert.equal(facts.refundable, false);
  assert.equal(facts.refusal, 'not_paid');
});
