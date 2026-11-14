import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createQuote, currentProPrice } from '../../dist/index.js';
import { openTestDatabase } from '../../dist/test-support.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// The owner's pricing, 12 Nov 2026, as data: Pro's default price becomes ₦5,000 a month through
// the price history (never by editing 0087), and old per-page deals are capped at the plan's rate.
const migration = (name) =>
  readFile(new URL(`../../drizzle/${name}.sql`, import.meta.url), 'utf8').then(
    (sql) => sql.split('--> statement-breakpoint'),
  );

test('a freshly migrated database charges ₦5,000 for Pro, with ₦2,500 kept as history and an audit row', async (t) => {
  // This process's own copy of the migrated template, read before any test resets it.
  const database = await openTestDatabase();
  t.after(() => database.close());
  const price = await currentProPrice(database.db);
  assert.equal(price.amountMinor, 500_000n);
  assert.equal(price.setBy, null);
  assert.match(price.reason, /12 Nov 2026/);
  const { rows: history } = await database.pool.query(
    `SELECT amount_minor::text AS amount FROM pro_prices ORDER BY effective_from, created_at`,
  );
  assert.deepEqual(
    history.map((row) => row.amount),
    ['250000', '500000'],
  );
  const { rows: audit } = await database.pool.query(
    `SELECT staff_user_id, permission, reason FROM audit_events
      WHERE action = 'pro.price_changed' AND subject_id = $1`,
    [price.id],
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].staff_user_id, null);
  assert.equal(audit[0].permission, 'pro.price');
  assert.match(audit[0].reason, /\[change: \{"from":"250000","to":"500000"/);
  // Running it again never adds a second ₦5,000 row (it only acts when the price differs).
  for (const statement of await migration('0093_pro_price_5000'))
    await database.pool.query(statement);
  assert.equal(
    (await database.pool.query(`SELECT count(*)::int AS n FROM pro_prices`))
      .rows[0].n,
    2,
  );
});

test('old deals at or above Free’s 7% are cleared with an audit row; lower deals stay', async (t) => {
  const db = await useDatabase(t);
  await db.fresh();
  // Ada: an old deal at 10% (now above every plan). Tobi: a Pro page with a 6% deal, between
  // Pro's 5% and Free's 7%: kept, and capped at 5% while Tobi is on Pro.
  await db.pool.query(
    `UPDATE profiles SET custom_fee_bps = 1000 WHERE id = $1`,
    [ADA],
  );
  await db.pool.query(
    `UPDATE profiles SET custom_fee_bps = 600, plan = 'pro', staff_pro = true WHERE id = $1`,
    [TOBI],
  );
  for (const statement of await migration('0094_fee_deals_capped'))
    await db.pool.query(statement);
  const fee = async (id) =>
    (
      await db.pool.query(`SELECT custom_fee_bps FROM profiles WHERE id = $1`, [
        id,
      ])
    ).rows[0].custom_fee_bps;
  assert.equal(await fee(ADA), null);
  assert.equal(await fee(TOBI), 600);
  const audit = async (id) =>
    (
      await db.pool.query(
        `SELECT action, staff_user_id, permission, reason FROM audit_events
          WHERE subject_type = 'profile' AND subject_id = $1 ORDER BY seq`,
        [id],
      )
    ).rows;
  const ada = await audit(ADA);
  assert.equal(ada.length, 1);
  assert.equal(ada[0].action, 'fee.capped');
  assert.equal(ada[0].staff_user_id, null);
  assert.equal(ada[0].permission, 'fees.manage');
  assert.match(ada[0].reason, /\[change: \{"from":1000,"to":null/);
  const tobi = await audit(TOBI);
  assert.equal(tobi.length, 1);
  assert.equal(tobi[0].action, 'fee.capped');
  assert.match(tobi[0].reason, /\[change: \{"from":600,"to":600,"onPro":500/);
  // And the quotes agree: Ada pays Free's 7%, Tobi Pro's 5%.
  const share = async (handle) => {
    const quote = await createQuote(db.db, {
      handle,
      tipMinor: 1_000_000n,
      currency: 'NGN',
    });
    return quote.breakdown.platformFeeMinor + quote.breakdown.providerFeeMinor;
  };
  assert.equal(await share('ada'), 70_000n);
  assert.equal(await share('tobi'), 50_000n);
  // Run again: nothing left to cap, no new audit rows.
  for (const statement of await migration('0094_fee_deals_capped'))
    await db.pool.query(statement);
  assert.equal((await audit(ADA)).length, 1);
  assert.equal((await audit(TOBI)).length, 1);
});
