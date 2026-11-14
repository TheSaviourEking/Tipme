import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  businessProState,
  confirmProCheckout,
  currentProPrice,
  DEMO_PROFILES,
  expireDuePeriods,
  mailSealing,
  OperationError,
  proPriceHistory,
  proRefundFacts,
  recomputeBusinessPlan,
  requestProPurchase,
  setProPrice,
  startBusinessPaidPeriod,
  startPaidPeriod,
} from '../../dist/index.js';
import { seedBusiness, seedManager } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Business Pro, plan Task A3: a business's months, plan and price, reusing personal Pro billing.

const sealing = mailSealing(Buffer.alloc(32, 9));
const ADA_USER = DEMO_PROFILES[0].userId;
const TOBI_USER = DEMO_PROFILES[1].userId;
const DAY = 86_400_000;
// Set after each reset: the seeded prices take effect at the reset's now().
let T0 = new Date();
const addDays = (date, days) => new Date(date.getTime() + days * DAY);
const key = () => `test-${randomUUID()}`;
const REASON = 'Business Pro price test';

async function setup(t, status = 'verified') {
  const db = await useDatabase(t);
  await db.fresh();
  T0 = new Date();
  const biz = await seedBusiness(db, { status });
  const q = (text, values = []) =>
    db.pool.query(text, values).then((result) => result.rows);
  const readBusiness = async (id = biz.businessId) =>
    (
      await q(`SELECT plan, pro_lapsed_at FROM businesses WHERE id = $1`, [id])
    )[0];
  const readProfile = async (id) =>
    (await q(`SELECT plan FROM profiles WHERE id = $1`, [id]))[0];
  const pay = (input = {}) =>
    db.db.transaction((tx) =>
      startBusinessPaidPeriod(tx, {
        businessId: biz.businessId,
        purchaseId: input.purchaseId ?? randomUUID(),
        paidBy: 'card',
        amountMinor: 700000n,
        currency: 'NGN',
        now: input.now ?? T0,
      }),
    );
  return { db, biz, q, readBusiness, readProfile, pay };
}

const expire = (db, now) => expireDuePeriods(db.db, { now, sealing });

test('a paid business month makes the business pro, and grace keeps it', async (t) => {
  const { db, readBusiness, pay, biz } = await setup(t);
  const started = await pay();
  assert.equal(started.status, 'ACTIVE');
  assert.equal(started.planChanged, true);
  assert.equal(started.slug, biz.slug);
  assert.equal((await readBusiness()).plan, 'pro');
  const result = await expire(db, addDays(started.endsAt, 1)); // in grace
  assert.equal((await readBusiness()).plan, 'pro');
  assert.deepEqual(result.businessChanges, []);
});

test('after grace the business is free and remembers when Pro ended', async (t) => {
  const { db, readBusiness, pay, biz } = await setup(t);
  const { endsAt } = await pay();
  await expire(db, addDays(endsAt, 1));
  const later = addDays(endsAt, 4);
  const result = await expire(db, later);
  assert.deepEqual(result.businessChanges, [
    { businessId: biz.businessId, slug: biz.slug, plan: 'free' },
  ]);
  const row = await readBusiness();
  assert.equal(row.plan, 'free');
  assert.equal(row.pro_lapsed_at.toISOString(), later.toISOString());
  // A new month clears the lapse.
  await pay({ now: addDays(later, 1) });
  assert.equal((await readBusiness()).pro_lapsed_at, null);
});

test('the same purchase starts one business month once; a third is refused', async (t) => {
  const { pay } = await setup(t);
  const purchaseId = randomUUID();
  const a = await pay({ purchaseId });
  const b = await pay({ purchaseId, now: addDays(T0, 1) });
  assert.equal(a.periodId, b.periodId);
  const queued = await pay({ now: addDays(T0, 2) });
  assert.equal(queued.status, 'SCHEDULED');
  assert.equal(queued.startsAt.toISOString(), a.endsAt.toISOString());
  await assert.rejects(
    pay({ now: addDays(T0, 3) }),
    (error) =>
      error instanceof OperationError && error.code === 'PRO_ALREADY_RENEWED',
  );
});

test('a business month never makes its owner personal Pro, and a page month never makes a business pro', async (t) => {
  const { db, readBusiness, readProfile, pay } = await setup(t);
  await pay();
  assert.equal((await readProfile(ADA)).plan, 'free');
  await db.db.transaction((tx) =>
    startPaidPeriod(tx, {
      profileId: TOBI,
      purchaseId: randomUUID(),
      paidBy: 'card',
      amountMinor: 250000n,
      currency: 'NGN',
      now: T0,
    }),
  );
  assert.equal((await readProfile(TOBI)).plan, 'pro');
  assert.equal((await readBusiness()).plan, 'pro');
});

test('recomputeBusinessPlan with no months leaves a business free', async (t) => {
  const { db, biz } = await setup(t);
  const result = await db.db.transaction((tx) =>
    recomputeBusinessPlan(tx, biz.businessId, T0),
  );
  assert.deepEqual(result, { plan: 'free', changed: false, slug: biz.slug });
});

test('a pending business cannot open a purchase', async (t) => {
  const { db, biz } = await setup(t, 'pending');
  await assert.rejects(
    requestProPurchase(db.db, {
      subject: { businessId: biz.businessId },
      boughtBy: ADA_USER,
      method: 'card',
      expectedAmountMinor: 700000n,
      idempotencyKey: key(),
      now: T0,
    }),
    (error) =>
      error instanceof OperationError && error.code === 'BUSINESS_NOT_VERIFIED',
  );
});

test('a business purchase is priced from the business plan and names who paid', async (t) => {
  const { db, biz } = await setup(t);
  await assert.rejects(
    requestProPurchase(db.db, {
      subject: { businessId: biz.businessId },
      boughtBy: ADA_USER,
      method: 'card',
      expectedAmountMinor: 250000n, // the personal price
      idempotencyKey: key(),
      now: T0,
    }),
    (error) =>
      error instanceof OperationError && error.code === 'PRO_PRICE_CHANGED',
  );
  await assert.rejects(
    requestProPurchase(db.db, {
      subject: { businessId: biz.businessId },
      method: 'card',
      expectedAmountMinor: 700000n,
      idempotencyKey: key(),
      now: T0,
    }),
    (error) =>
      error instanceof OperationError && error.code === 'INVALID_INPUT',
  );
  const idempotencyKey = key();
  const { purchase } = await requestProPurchase(db.db, {
    subject: { businessId: biz.businessId },
    boughtBy: ADA_USER,
    method: 'card',
    expectedAmountMinor: 700000n,
    idempotencyKey,
    now: T0,
  });
  assert.equal(purchase.businessId, biz.businessId);
  assert.equal(purchase.profileId, null);
  assert.equal(purchase.boughtBy, ADA_USER);
  assert.equal(purchase.amountMinor, 700000n);
  const again = await requestProPurchase(db.db, {
    subject: { businessId: biz.businessId },
    boughtBy: ADA_USER,
    method: 'card',
    expectedAmountMinor: 700000n,
    idempotencyKey,
    now: T0,
  });
  assert.equal(again.replayed, true);
  assert.equal(again.purchase.id, purchase.id);
  await assert.rejects(
    requestProPurchase(db.db, {
      subject: { businessId: biz.businessId },
      boughtBy: ADA_USER,
      method: 'card',
      expectedAmountMinor: 700000n,
      idempotencyKey: key(),
      now: T0,
    }),
    (error) =>
      error instanceof OperationError && error.code === 'PRO_PURCHASE_OPEN',
  );
});

test('a confirmed business checkout starts a business month, booked once', async (t) => {
  const { db, biz, q, readBusiness } = await setup(t);
  const { purchase } = await requestProPurchase(db.db, {
    subject: { businessId: biz.businessId },
    boughtBy: ADA_USER,
    method: 'card',
    expectedAmountMinor: 700000n,
    idempotencyKey: key(),
    now: T0,
  });
  const verified = {
    status: 'succeeded',
    amountMinor: 700000n,
    currency: 'NGN',
    feeMinor: 10500n,
  };
  const confirm = () =>
    confirmProCheckout(db.db, {
      purchaseId: purchase.id,
      verified,
      now: T0,
      sealing,
    });
  const first = await confirm();
  assert.equal(first.outcome, 'paid');
  assert.equal(first.businessId, biz.businessId);
  assert.equal(first.profileId, null);
  assert.equal(first.planChanged, true);
  assert.equal((await readBusiness()).plan, 'pro');
  assert.equal((await confirm()).outcome, 'already');
  const periods = await q(
    `SELECT business_id, profile_id FROM pro_periods WHERE purchase_id = $1`,
    [purchase.id],
  );
  assert.deepEqual(periods, [
    { business_id: biz.businessId, profile_id: null },
  ]);
  const postings = await q(
    `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_key = $1`,
    [`pro.${purchase.id}`],
  );
  assert.equal(postings[0].n, 1);
});

test('a refund of a business month names its open owners as subjects', async (t) => {
  const { db, biz, q } = await setup(t);
  await seedManager(db, { businessId: biz.businessId, userId: TOBI_USER });
  const { purchase } = await requestProPurchase(db.db, {
    subject: { businessId: biz.businessId },
    boughtBy: ADA_USER,
    method: 'card',
    expectedAmountMinor: 700000n,
    idempotencyKey: key(),
    now: T0,
  });
  const facts = await proRefundFacts(db.db, purchase.id, T0);
  assert.equal(facts.profileId, null);
  assert.equal(facts.businessId, biz.businessId);
  const owners = await q(
    `SELECT user_id FROM business_managers WHERE business_id = $1 AND role = 'owner' AND removed_at IS NULL`,
    [biz.businessId],
  );
  assert.equal(owners.length, 2);
});

test('business and personal prices move separately', async (t) => {
  const { db, q } = await setup(t);
  const now = new Date();
  const personalBefore = (await currentProPrice(db.db, now)).amountMinor;
  await db.db.transaction((tx) =>
    setProPrice(tx, {
      amountMinor: 750000n,
      plan: 'business',
      staffUserId: ADA_USER,
      approvedBy: TOBI_USER,
      reason: REASON,
      now,
    }),
  );
  const business = await currentProPrice(db.db, now, 'business');
  assert.equal(business.amountMinor, 750000n);
  assert.equal(business.plan, 'business');
  assert.equal((await currentProPrice(db.db, now)).amountMinor, personalBefore);
  const history = await proPriceHistory(db.db, 50, 'business');
  assert.ok(history.every((row) => row.plan === 'business'));
  assert.equal(history[0].amountMinor, 750000n);
  const audit = await q(
    `SELECT action FROM audit_events WHERE subject_id = $1`,
    [business.id],
  );
  assert.deepEqual(
    audit.map((row) => row.action),
    ['business_pro.price_changed'],
  );
});

test('businessProState reads the plan, the months and the business price', async (t) => {
  const { db, biz, pay } = await setup(t);
  const before = await businessProState(db.db, biz.businessId, T0);
  assert.equal(before.plan, 'free');
  assert.equal(before.current, null);
  assert.equal(before.price.amountMinor, 700000n);
  const started = await pay();
  const after = await businessProState(db.db, biz.businessId, T0);
  assert.equal(after.plan, 'pro');
  assert.equal(
    after.current.endsAt.toISOString(),
    started.endsAt.toISOString(),
  );
  assert.equal(after.next, null);
  assert.equal(after.lapsedAt, null);
});
