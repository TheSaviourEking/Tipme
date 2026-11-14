import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BUSINESS_PLANS, PRO_PRICE_PLANS } from '../../dist/index.js';
import { seedBusiness } from './business-fixtures.mjs';
import { ADA, useDatabase } from './helpers.mjs';
import { DEMO_PROFILES } from '../../dist/index.js';

// Business Pro, plan Task A1: what the database itself refuses once the pro tables take a business.

const ADA_USER = DEMO_PROFILES[0].userId;
const DAY = 86_400_000;

const refused = (promise, name) =>
  assert.rejects(promise, (error) => {
    assert.match(String(error.constraint ?? error.message), name);
    return true;
  });

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  const biz = await seedBusiness(db);
  const q = (text, values = []) =>
    db.pool.query(text, values).then((result) => result.rows);
  const currentPrice = async (plan) =>
    (
      await q(
        `SELECT id, amount_minor::text, reason FROM pro_prices
          WHERE plan = $1 AND effective_from <= now()
          ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
        [plan],
      )
    )[0];
  const businessPrice = await currentPrice('business');
  const insertPeriod = ({
    profileId = null,
    businessId = null,
    status = 'ACTIVE',
    startsAt = new Date(),
  }) =>
    q(
      `INSERT INTO pro_periods (id, profile_id, business_id, starts_at, ends_at, grace_ends_at,
         status, paid_by, amount_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'card', 700000, 'NGN')`,
      [
        randomUUID(),
        profileId,
        businessId,
        startsAt,
        new Date(startsAt.getTime() + 30 * DAY),
        new Date(startsAt.getTime() + 33 * DAY),
        status,
      ],
    );
  const insertPurchase = ({
    profileId = null,
    businessId = null,
    boughtBy = businessId ? ADA_USER : null,
    status = 'PENDING',
  }) =>
    q(
      `INSERT INTO pro_purchases (id, profile_id, business_id, bought_by, method, price_id,
         amount_minor, currency, status, idempotency_key, fingerprint)
       VALUES ($1, $2, $3, $4, 'card', $5, 700000, 'NGN', $6, $7, 'fp')`,
      [
        randomUUID(),
        profileId,
        businessId,
        boughtBy,
        businessPrice.id,
        status,
        randomUUID(),
      ],
    );
  const readBusiness = async (id) =>
    (
      await q(`SELECT plan, pro_lapsed_at FROM businesses WHERE id = $1`, [id])
    )[0];
  const setPlan = (id, plan) =>
    q(`UPDATE businesses SET plan = $2 WHERE id = $1`, [id, plan]);
  return {
    db,
    biz,
    q,
    currentPrice,
    insertPeriod,
    insertPurchase,
    readBusiness,
    setPlan,
  };
}

test('the plan names are exported', () => {
  assert.deepEqual([...BUSINESS_PLANS], ['free', 'pro']);
  assert.deepEqual([...PRO_PRICE_PLANS], ['personal', 'business']);
});

test('pro_periods take exactly one of a page or a business', async (t) => {
  const { biz, insertPeriod } = await setup(t);
  await refused(
    insertPeriod({ profileId: null, businessId: null }),
    /pro_periods_owner/,
  );
  await refused(
    insertPeriod({ profileId: ADA, businessId: biz.businessId }),
    /pro_periods_owner/,
  );
  await insertPeriod({ profileId: null, businessId: biz.businessId }); // ok
});

test('a business has at most one queued month and one open purchase', async (t) => {
  const { biz, insertPeriod, insertPurchase } = await setup(t);
  const later = new Date(Date.now() + 40 * DAY);
  await insertPeriod({ businessId: biz.businessId, status: 'SCHEDULED' });
  await refused(
    insertPeriod({
      businessId: biz.businessId,
      status: 'SCHEDULED',
      startsAt: later,
    }),
    /pro_periods_business_one_scheduled/,
  );
  await insertPurchase({ businessId: biz.businessId, status: 'PENDING' });
  await refused(
    insertPurchase({ businessId: biz.businessId, status: 'UNKNOWN' }),
    /pro_purchases_business_one_open/,
  );
});

test('a purchase takes exactly one of a page or a business', async (t) => {
  const { biz, insertPurchase } = await setup(t);
  await refused(insertPurchase({}), /pro_purchases_owner/);
  await refused(
    insertPurchase({ profileId: ADA, businessId: biz.businessId }),
    /pro_purchases_owner/,
  );
});

test('a business purchase names the owner who paid, a page purchase does not', async (t) => {
  const { biz, insertPurchase } = await setup(t);
  await refused(
    insertPurchase({ businessId: biz.businessId, boughtBy: null }),
    /pro_purchases_bought_by/,
  );
  await refused(
    insertPurchase({ profileId: ADA, boughtBy: ADA_USER }),
    /pro_purchases_bought_by/,
  );
});

test('the seed sets Business Pro at 700000 kobo and leaves the personal price alone', async (t) => {
  const { currentPrice, q } = await setup(t);
  const business = await currentPrice('business');
  assert.equal(business.amount_minor, '700000');
  assert.match(business.reason, /owner’s decision, 14 Nov 2026/);
  assert.notEqual((await currentPrice('personal')).id, business.id);
  await refused(
    q(
      `INSERT INTO pro_prices (id, amount_minor, currency, effective_from, plan, reason)
       VALUES ($1, 100000, 'NGN', now(), 'gold', 'x')`,
      [randomUUID()],
    ),
    /pro_prices_plan/,
  );
});

test('every business starts on free', async (t) => {
  const { biz, readBusiness, setPlan } = await setup(t);
  const row = await readBusiness(biz.businessId);
  assert.equal(row.plan, 'free');
  assert.equal(row.pro_lapsed_at, null);
  await refused(setPlan(biz.businessId, 'gold'), /businesses_plan/);
});

test('business auto-renew takes a balance or a saved card, set by someone', async (t) => {
  const { biz, q } = await setup(t);
  const insert = (source, setBy = ADA_USER) =>
    q(
      `INSERT INTO business_pro_auto_renew (business_id, source, enabled, set_by)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (business_id) DO UPDATE SET source = EXCLUDED.source`,
      [biz.businessId, source, setBy],
    );
  await refused(insert('cash'), /business_pro_auto_renew_source/);
  await insert('balance');
  await insert('saved_card');
});
