import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  findQuoteCharge,
  grantOwner,
  markAttemptInitiated,
  pagePricing,
  planFeeRateHistory,
  planFeeRatesInForce,
  recordProviderEvent,
  setAccountFee,
  setPagePlan,
  setPlanFeeRates,
} from '../../dist/index.js';
import { openTestDatabase } from '../../dist/test-support.js';
import { ADA, useDatabase } from './helpers.mjs';

// The owner, 18 Nov 2026: the two plan rates are an admin setting, Free 5% and Pro 3% to start.
// New quotes read the setting; a quote already shown keeps its fee; paid tips are never touched.

const share = (b) => b.platformFeeMinor + b.providerFeeMinor;

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  const { userId: staff } = await grantOwner(db.db, {
    phone: '+2348000007788',
  });
  const set = (freeBps, proBps, now = new Date()) =>
    db.db.transaction((tx) =>
      setPlanFeeRates(tx, {
        freeBps,
        proBps,
        staffUserId: staff,
        approvedBy: null,
        reason: 'Rates for the plan fee test',
        now,
      }),
    );
  const quote = (now = undefined) =>
    createQuote(db.db, {
      handle: 'ada',
      tipMinor: 1_000_000n,
      currency: 'NGN',
      ...(now ? { now } : {}),
    });
  return { db, staff, set, quote };
}

test('a freshly migrated database holds Free 500 and Pro 300, set by the owner, with an audit row', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  // After a reset too: the same row and audit row the migration wrote (test-support.ts re-seeds them).
  await database.reset();
  const rates = await planFeeRatesInForce(database.db);
  assert.equal(rates.freeBps, 500n);
  assert.equal(rates.proBps, 300n);
  assert.equal(rates.source, 'setting');
  const [row] = await planFeeRateHistory(database.db);
  assert.equal(row.setBy, null);
  assert.match(row.reason, /18 Nov 2026/);
  const { rows: audit } = await database.pool.query(
    `SELECT staff_user_id, permission, reason FROM audit_events
      WHERE action = 'plan_fees.changed' AND subject_id = $1`,
    [row.id],
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].staff_user_id, null);
  assert.equal(audit[0].permission, 'fees.manage');
  assert.match(audit[0].reason, /"to":\{"freeBps":"500","proBps":"300"\}/);
});

test('a test reset re-seeds the same 500/300 row and audit row as the migration', async (t) => {
  const db = await useDatabase(t);
  await db.fresh();
  const rates = await planFeeRatesInForce(db.db);
  assert.deepEqual(
    { free: rates.freeBps, pro: rates.proBps, source: rates.source },
    { free: 500n, pro: 300n, source: 'setting' },
  );
  const history = await planFeeRateHistory(db.db);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, '00000000-0000-4000-8000-000000000503');
  assert.equal(history[0].setBy, null);
  assert.match(history[0].reason, /18 Nov 2026/);
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE action = 'plan_fees.changed' AND subject_id = $1`,
    [history[0].id],
  );
  assert.equal(rows[0].n, 1);
});

test('with no stored rates the coded defaults apply: 5% and 3%', async (t) => {
  const { db, quote } = await setup(t);
  // The reset seeds the setting; emptying the table (a test-only opt-in) is the fallback path.
  await db.pool.query('BEGIN');
  await db.pool.query(`SET LOCAL tipme.allow_truncate = 'on'`);
  await db.pool.query('TRUNCATE plan_fee_rates');
  await db.pool.query('COMMIT');
  const rates = await planFeeRatesInForce(db.db);
  assert.deepEqual(
    { free: rates.freeBps, pro: rates.proBps, source: rates.source },
    { free: 500n, pro: 300n, source: 'default' },
  );
  assert.equal(share((await quote()).breakdown), 50_000n);
});

test('the setting overrides the defaults for new quotes, on both plans', async (t) => {
  const { db, staff, set, quote } = await setup(t);
  await set(450n, 250n);
  const free = await quote();
  assert.equal(share(free.breakdown), 45_000n);
  assert.equal(free.feePolicyVersion, 'v3-free-450bps');
  await setPagePlan(db.db, {
    staffUserId: staff,
    profileId: ADA,
    plan: 'pro',
    reason: 'Plan for the fee test',
  });
  const pro = await quote();
  assert.equal(share(pro.breakdown), 25_000n);
  assert.equal(pro.feePolicyVersion, 'v3-pro-250bps');
  const pricing = await pagePricing(db.db, ADA);
  assert.equal(pricing.planFeeBps, 250);
  assert.equal(pricing.feeBps, 250);
});

test('a per-account fee still wins below the set rate, and is capped at it above', async (t) => {
  const { db, staff, set, quote } = await setup(t);
  await setAccountFee(db.db, {
    profileId: ADA,
    staffUserId: staff,
    feeBps: 400,
    reason: 'Deal for the fee test',
  });
  assert.equal(share((await quote()).breakdown), 40_000n);
  // Free lowered to 3.5%: the 4% deal is above it, so the plan's rate applies.
  await set(350n, 300n);
  const capped = await quote();
  assert.equal(share(capped.breakdown), 35_000n);
  assert.equal(capped.feePolicyVersion, 'v3-free-350bps');
  // Raised back to 5%: the deal wins again.
  await set(500n, 300n);
  const deal = await quote();
  assert.equal(share(deal.breakdown), 40_000n);
  assert.equal(deal.feePolicyVersion, 'v3-free-500bps-custom-400');
  assert.equal((await pagePricing(db.db, ADA)).feeBps, 400);
});

test('a quote made before a rate change keeps its fee through checkout and payment', async (t) => {
  const { db, set, quote } = await setup(t);
  const before = await quote();
  assert.equal(share(before.breakdown), 50_000n);
  await set(700n, 300n);
  // What the partner is asked to charge is what the quote showed.
  const charge = await findQuoteCharge(db.db, before.quoteId);
  assert.equal(charge.platformFeeMinor + charge.providerFeeMinor, 50_000n);
  // Checkout and the payment use the quote, never the live rate.
  const intent = await createPaymentIntent(db.db, {
    quoteId: before.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `chk_${randomUUID().slice(0, 8)}`;
  await markAttemptInitiated(db.db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await recordProviderEvent(db.db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 1_000_000n,
    currency: 'NGN',
    providerFeeMinor: 15_000n,
    signatureVerified: true,
    payload: {},
  });
  // The ledger books the quote's amounts: TipMe's ₦500 (platform ₦350 + processing ₦150 recovered),
  // ₦9,500 to Ada, whatever the rate is now.
  const { rows } = await db.pool.query(
    `SELECT a.code, e.side, e.amount_minor::text AS amount
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions lt ON lt.id = e.transaction_id
       JOIN tips t ON t.id = lt.tip_id
       JOIN payment_intents i ON i.id = t.intent_id
      WHERE i.quote_id = $1 AND e.side = 'credit' ORDER BY a.code`,
    [before.quoteId],
  );
  assert.deepEqual(rows, [
    { code: 'platform_fee_revenue', side: 'credit', amount: '35000' },
    { code: 'provider_fee_recovered', side: 'credit', amount: '15000' },
    { code: 'recipient_payable', side: 'credit', amount: '950000' },
  ]);
  // A new quote uses the new rate.
  assert.equal(share((await quote()).breakdown), 70_000n);
});

test('a rate change never rewrites a stored quote, tip or ledger row', async (t) => {
  const { db, set, quote } = await setup(t);
  const q = await quote();
  const snapshot = async () =>
    (
      await db.pool.query(
        `SELECT (SELECT json_agg(x ORDER BY x.id) FROM tip_quotes x) AS quotes,
                (SELECT count(*)::int FROM ledger_entries) AS entries`,
      )
    ).rows[0];
  const was = await snapshot();
  await set(300n, 200n);
  assert.deepEqual(await snapshot(), was);
  assert.ok(q.quoteId);
});

test('out-of-range rates, and Pro above Free, are refused; the stored rates stay', async (t) => {
  const { db, set } = await setup(t);
  await set(450n, 250n);
  for (const [free, pro] of [
    [-1n, 0n],
    [0n, 0n],
    [149n, 149n],
    // Profit guards, Part 3: 2% is the floor for a new setting.
    [199n, 199n],
    [150n, 150n],
    [500n, 199n],
    [1001n, 300n],
    [10001n, 300n],
    [500n, 149n],
    [1000n, 1001n],
    [300n, 500n],
    // Unchanged.
    [450n, 250n],
  ])
    await assert.rejects(
      set(free, pro),
      (error) => error.code === 'INVALID_INPUT',
      `${free}/${pro}`,
    );
  const rates = await planFeeRatesInForce(db.db);
  assert.equal(rates.freeBps, 450n);
  assert.equal(rates.proBps, 250n);
});

test('a rate stored below the floor before it existed still prices quotes and reads back; a new setting must be 200 or more', async (t) => {
  const { db, set, quote } = await setup(t);
  await db.pool.query(
    `INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, reason)
     VALUES (gen_random_uuid(), 150, 150, now() + interval '10 seconds', 'before the floor')`,
  );
  const later = new Date(Date.now() + 60_000);
  const rates = await planFeeRatesInForce(db.db, later);
  assert.equal(rates.source, 'setting');
  assert.equal(rates.freeBps, 150n);
  assert.equal(rates.proBps, 150n);
  const old = await quote(later);
  assert.equal(old.feePolicyVersion, 'v3-free-150bps');
  // Saving anything below 200 is refused, 200 is saved.
  await assert.rejects(
    set(150n, 150n),
    (error) => error.code === 'INVALID_INPUT',
  );
  await set(200n, 200n, new Date(later.getTime() + 60_000));
  assert.equal(
    (await planFeeRatesInForce(db.db, new Date(later.getTime() + 120_000)))
      .freeBps,
    200n,
  );
});

test('the rates table is history: rows cannot be updated or deleted', async (t) => {
  const { db, set } = await setup(t);
  await set(450n, 250n);
  await assert.rejects(db.pool.query(`UPDATE plan_fee_rates SET free_bps = 1`));
  await assert.rejects(db.pool.query(`DELETE FROM plan_fee_rates`));
  // And the database itself refuses Pro above Free or a rate out of bounds.
  await assert.rejects(
    db.pool.query(
      `INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, reason)
       VALUES (gen_random_uuid(), 300, 500, now(), 'bad')`,
    ),
  );
  // Each rate is 150 to 1000 bps: the table itself refuses 149 and 1001 on either plan.
  for (const [free, pro] of [
    [10001, 300],
    [1001, 300],
    [500, 149],
    [149, 149],
    [500, 0],
  ])
    await assert.rejects(
      db.pool.query(
        `INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, reason)
         VALUES (gen_random_uuid(), $1, $2, now(), 'bad')`,
        [free, pro],
      ),
      `${free}/${pro}`,
    );
  for (const [free, pro] of [
    [150, 150],
    [1000, 1000],
  ])
    await db.pool.query(
      `INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, reason)
       VALUES (gen_random_uuid(), $1, $2, now() + interval '1 day', 'edge')`,
      [free, pro],
    );
});

test('a move of more than 200 bps on either plan needs the explicit confirm; 200 does not', async (t) => {
  const { db, staff } = await setup(t);
  const change = (freeBps, proBps, confirmedLargeChange) =>
    db.db.transaction((tx) =>
      setPlanFeeRates(tx, {
        freeBps,
        proBps,
        staffUserId: staff,
        approvedBy: null,
        reason: 'A big move',
        now: new Date(),
        ...(confirmedLargeChange === undefined ? {} : { confirmedLargeChange }),
      }),
    );
  // From 500/300: Free +201, Free +300, and Free +400 with Pro +250 all need the confirm.
  for (const [free, pro] of [
    [701n, 300n],
    [800n, 300n],
    [900n, 550n],
  ])
    await assert.rejects(
      change(free, pro),
      (error) => error.code === 'PLAN_FEES_CONFIRM_REQUIRED',
      `${free}/${pro}`,
    );
  await assert.rejects(
    change(800n, 300n, false),
    (error) => error.code === 'PLAN_FEES_CONFIRM_REQUIRED',
  );
  assert.equal((await planFeeRatesInForce(db.db)).freeBps, 500n);
  // Exactly 200 on a plan is not "more than 200".
  await change(700n, 500n);
  assert.equal((await planFeeRatesInForce(db.db)).freeBps, 700n);
  // Confirmed, a big move goes through (and so does a big drop).
  await change(1000n, 300n, true);
  const rates = await planFeeRatesInForce(db.db);
  assert.deepEqual([rates.freeBps, rates.proBps], [1000n, 300n]);
  await change(500n, 300n, true);
  assert.equal((await planFeeRatesInForce(db.db)).freeBps, 500n);
});
