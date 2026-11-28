import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lagosMonthStart } from '@tipme/domain';
import {
  createPaymentIntent,
  createQuote,
  feeWaiverCost,
  grantFeeFreeTips,
  grantOwner,
  markAttemptInitiated,
  recordProviderEvent,
} from '../../dist/index.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Fee waivers, plan Task 6 (spec 2026-11-23 §6, W12; rulings R9, R10): what waivers cost TipMe, as
// two figures that are never added together.

const HOUR = 3_600_000;
const NOW = new Date();
const at = (hours) => new Date(NOW.getTime() + hours * HOUR);
const WINDOW = { from: at(-48), to: at(1) };

async function setup(t) {
  const database = await useDatabase(t);
  await database.fresh();
  return database;
}

/** One rule row straight into the table; `createdAt` defaults to `startsAt`. */
async function insertRule(
  database,
  { scope = 'kind', kind = 'individual', profileId = null, fee = 'tip' } = {},
) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at,
       ends_at, reason, set_by, approved_by, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 'tipme', $6, NULL, 'Test rule', NULL, NULL, $6)`,
    [id, scope, kind, profileId, fee, at(-24 * 30)],
  );
  return id;
}

/** A paid tip to `handle`; the partner keeps `providerFeeMinor`. Returns the tip id. */
async function pay(
  database,
  handle,
  { providerFeeMinor = 7500n, tipMinor = 500000n, outcome = 'succeeded' } = {},
) {
  const quote = await createQuote(database.db, {
    handle,
    tipMinor,
    currency: 'NGN',
    youCollectOn: false,
    activeProvider: 'mock',
  });
  const intent = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `mock_pay_${randomUUID()}`;
  await markAttemptInitiated(database.db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: quote.breakdown.payerTotalMinor,
    currency: 'NGN',
    providerFeeMinor,
    signatureVerified: true,
    payload: {},
  });
  return { tipId: intent.tipId, quoteId: quote.quoteId };
}

/** A payout row as the request path leaves it, whatever its status. */
async function payout(
  database,
  {
    profileId = ADA,
    status = 'PAID',
    ruleId = null,
    waivedFeeMinor = 0n,
    paidAt = at(-1),
  } = {},
) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
       request_fingerprint, paid_at, fee_waiver_id, waived_fee_minor)
     VALUES ($1, $2, 'NGN', 300000, $3, $4, $4, $5, $6, $7)`,
    [
      id,
      profileId,
      status,
      randomUUID(),
      status === 'PAID' ? paidAt : null,
      ruleId,
      waivedFeeMinor,
    ],
  );
  return id;
}

const completedAt = (database, tipId, when) =>
  database.pool.query('UPDATE tips SET completed_at = $2 WHERE id = $1', [
    tipId,
    when,
  ]);

test('cost shows fee income given up and cash paid apart', async (t) => {
  const database = await setup(t);
  const rule = await insertRule(database);
  await pay(database, 'ada', { providerFeeMinor: 7500n });
  await pay(database, 'tobi', { providerFeeMinor: 6000n });
  await payout(database, { ruleId: rule, waivedFeeMinor: 5000n });
  // A split request: the other part carries no fee and adds nothing.
  await payout(database, { ruleId: rule, waivedFeeMinor: 0n });
  // An unwaived payout is nobody's cost here.
  await payout(database, {});

  const cost = await feeWaiverCost(database.db, WINDOW);
  // Each tip waived 5% of ₦5,000 (₦250.00 = 25000 minor), processing included.
  assert.equal(cost.incomeGivenUpMinor, 50000n);
  assert.equal(cost.cashPaidMinor, 7500n + 6000n + 5000n);
});

test('fee-free credit tips and failed tips never count', async (t) => {
  const database = await setup(t);
  const { userId: staff } = await grantOwner(database.db, {
    phone: '+2348000009999',
  });
  await grantFeeFreeTips(database.db, {
    profileId: ADA,
    staffUserId: staff,
    count: 1,
    reason: 'Apology for downtime',
  });
  // No rule yet: this tip uses the credit, so it waives a fee but under no waiver.
  await pay(database, 'ada');
  await insertRule(database);
  await pay(database, 'tobi', { outcome: 'failed' });
  // A waived payout that never paid is not cash paid.
  await payout(database, {
    ruleId: await insertRule(database, { fee: 'withdrawal' }),
    status: 'FAILED',
    waivedFeeMinor: 5000n,
  });

  assert.deepEqual(await feeWaiverCost(database.db, WINDOW), {
    incomeGivenUpMinor: 0n,
    cashPaidMinor: 0n,
  });
});

test('a rule, a kind and an account each filter correctly', async (t) => {
  const database = await setup(t);
  const individual = await insertRule(database);
  const business = await insertRule(database, { kind: 'giving' });
  const adaTip = await pay(database, 'ada', { providerFeeMinor: 7500n });
  const tobiTip = await pay(database, 'tobi', { providerFeeMinor: 6000n });
  // Re-point Tobi's tip at another kind's rule, as a different spell would have left it.
  await database.pool.query(
    'UPDATE tip_quotes SET fee_waiver_id = $2 WHERE id = $1',
    [tobiTip.quoteId, business],
  );
  await payout(database, {
    profileId: TOBI,
    ruleId: business,
    waivedFeeMinor: 5000n,
  });
  assert.ok(adaTip);

  const of = (extra) => feeWaiverCost(database.db, { ...WINDOW, ...extra });
  assert.deepEqual(await of({}), {
    incomeGivenUpMinor: 50000n,
    cashPaidMinor: 7500n + 6000n + 5000n,
  });
  assert.deepEqual(await of({ ruleId: individual }), {
    incomeGivenUpMinor: 25000n,
    cashPaidMinor: 7500n,
  });
  assert.deepEqual(await of({ kind: 'giving' }), {
    incomeGivenUpMinor: 25000n,
    cashPaidMinor: 6000n + 5000n,
  });
  assert.deepEqual(await of({ owner: { profileId: ADA } }), {
    incomeGivenUpMinor: 25000n,
    cashPaidMinor: 7500n,
  });
  assert.deepEqual(await of({ owner: { profileId: TOBI }, kind: 'giving' }), {
    incomeGivenUpMinor: 25000n,
    cashPaidMinor: 6000n + 5000n,
  });
});

test('only tips and payouts completed in the period count', async (t) => {
  const database = await setup(t);
  const rule = await insertRule(database);
  const old = await pay(database, 'ada');
  await completedAt(database, old.tipId, at(-24 * 10));
  await pay(database, 'ada', { providerFeeMinor: 7500n });
  await payout(database, {
    ruleId: rule,
    waivedFeeMinor: 5000n,
    paidAt: at(-24 * 10),
  });
  assert.deepEqual(await feeWaiverCost(database.db, WINDOW), {
    incomeGivenUpMinor: 25000n,
    cashPaidMinor: 7500n,
  });
});

test('this month starts at Lagos midnight on the 1st', () => {
  // 31 Oct 23:30 UTC is already 1 Nov 00:30 in Lagos (UTC+1).
  assert.equal(
    lagosMonthStart(new Date('2026-10-31T23:30:00Z')).toISOString(),
    '2026-10-31T23:00:00.000Z',
  );
  assert.equal(
    lagosMonthStart(new Date('2026-11-30T22:59:00Z')).toISOString(),
    '2026-10-31T23:00:00.000Z',
  );
  assert.equal(
    lagosMonthStart(new Date('2026-11-30T23:00:00Z')).toISOString(),
    '2026-11-30T23:00:00.000Z',
  );
});
