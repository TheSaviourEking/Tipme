import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardCostAt,
  cardCostHistory,
  grantOwner,
  setCardCosts,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Owner, 26 Nov 2026: what a card payment costs TipMe (rate, 3D Secure fixed cost, margin) is an ops
// setting like the plan fees: append-only history, the latest row in force, coded defaults when none.

const DEFAULTS = { rateBps: 200n, fixedMinor: 4500n, marginMinor: 1500n };

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  const { userId: staff } = await grantOwner(db.db, {
    phone: '+2348000007789',
  });
  const set = (cost, now = new Date(), approvedBy = null) =>
    db.db.transaction((tx) =>
      setCardCosts(tx, {
        cost,
        actorId: staff,
        approvedBy,
        reason: 'The partner’s new card price',
        now,
      }),
    );
  return { db, staff, set };
}

test('with no stored card cost the coded defaults apply: 2% + ₦45, margin ₦15', async (t) => {
  const { db } = await setup(t);
  assert.equal(await db.count('card_cost_settings'), 0);
  assert.deepEqual(await cardCostAt(db.db, new Date()), DEFAULTS);
  assert.deepEqual(await cardCostHistory(db.db, 10), []);
});

test('a change applies from its time: a moment before reads the old cost, from then the new', async (t) => {
  const { db, set, staff } = await setup(t);
  const at = new Date();
  const next = { rateBps: 250n, fixedMinor: 5000n, marginMinor: 2000n };
  await set(next, at);
  assert.deepEqual(
    await cardCostAt(db.db, new Date(at.getTime() - 1)),
    DEFAULTS,
  );
  assert.deepEqual(await cardCostAt(db.db, at), next);
  assert.deepEqual(
    await cardCostAt(db.db, new Date(at.getTime() + 60_000)),
    next,
  );
  // A second change, later: each moment reads the row in force then.
  const later = new Date(at.getTime() + 1000);
  const after = { rateBps: 180n, fixedMinor: 4500n, marginMinor: 0n };
  await set(after, later);
  assert.deepEqual(
    await cardCostAt(db.db, new Date(later.getTime() - 1)),
    next,
  );
  assert.deepEqual(await cardCostAt(db.db, later), after);
  const history = await cardCostHistory(db.db, 10);
  assert.equal(history.length, 2);
  assert.equal(history[0].rateBps, 180);
  assert.equal(history[0].fixedMinor, 4500n);
  assert.equal(history[0].setBy, staff);
  assert.equal(history[0].approvedBy, null);
  assert.equal(history[1].rateBps, 250);
  assert.equal((await cardCostHistory(db.db, 1)).length, 1);
});

test('a change is audited with from, to and approver', async (t) => {
  const { db, set, staff } = await setup(t);
  const { userId: approver } = await grantOwner(db.db, {
    phone: '+2348000007790',
  });
  await set(
    { rateBps: 250n, fixedMinor: 5000n, marginMinor: 2000n },
    new Date(),
    approver,
  );
  const [row] = await cardCostHistory(db.db, 1);
  assert.equal(row.approvedBy, approver);
  const { rows } = await db.pool.query(
    `SELECT staff_user_id, permission, subject_type, subject_id, reason FROM audit_events
      WHERE action = 'card_costs.changed'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].staff_user_id, staff);
  assert.equal(rows[0].permission, 'fees.manage');
  assert.equal(rows[0].subject_type, 'card_cost_settings');
  assert.equal(rows[0].subject_id, row.id);
  assert.ok(rows[0].reason.startsWith('The partner’s new card price'));
  assert.match(
    rows[0].reason,
    /"from":\{"rateBps":"200","fixedMinor":"4500","marginMinor":"1500"\}/,
  );
  assert.match(
    rows[0].reason,
    /"to":\{"rateBps":"250","fixedMinor":"5000","marginMinor":"2000"\}/,
  );
  assert.match(rows[0].reason, new RegExp(`"approvedBy":"${approver}"`));
});

test('out-of-bounds and unchanged costs are refused INVALID_INPUT', async (t) => {
  const { db, set } = await setup(t);
  for (const cost of [
    { rateBps: 10001n, fixedMinor: 4500n, marginMinor: 1500n },
    { rateBps: -1n, fixedMinor: 4500n, marginMinor: 1500n },
    { rateBps: 200n, fixedMinor: -1n, marginMinor: 1500n },
    { rateBps: 200n, fixedMinor: 4500n, marginMinor: -1n },
    // The defaults, unchanged.
    DEFAULTS,
  ])
    await assert.rejects(
      set(cost),
      (error) => error.code === 'INVALID_INPUT',
      JSON.stringify(cost, (_, v) => (typeof v === 'bigint' ? `${v}` : v)),
    );
  assert.equal(await db.count('card_cost_settings'), 0);
});

test('the card cost table is history, and refuses values out of bounds itself', async (t) => {
  const { db, set } = await setup(t);
  await set({ rateBps: 250n, fixedMinor: 5000n, marginMinor: 2000n });
  await assert.rejects(
    db.pool.query(`UPDATE card_cost_settings SET rate_bps = 1`),
  );
  await assert.rejects(db.pool.query(`DELETE FROM card_cost_settings`));
  await assert.rejects(db.pool.query(`TRUNCATE card_cost_settings`));
  for (const [rate, fixed, margin, reason] of [
    [10001, 4500, 1500, 'bad'],
    [-1, 4500, 1500, 'bad'],
    [200, -1, 1500, 'bad'],
    [200, 4500, -1, 'bad'],
    [200, 4500, 1500, ''],
  ])
    await assert.rejects(
      db.pool.query(
        `INSERT INTO card_cost_settings (id, rate_bps, fixed_minor, margin_minor, effective_from, reason)
         VALUES (gen_random_uuid(), $1, $2, $3, now(), $4)`,
        [rate, fixed, margin, reason],
      ),
      `${rate}/${fixed}/${margin}/${reason}`,
    );
  for (const [rate, fixed, margin] of [
    [0, 0, 0],
    [10000, 100000, 100000],
  ])
    await db.pool.query(
      `INSERT INTO card_cost_settings (id, rate_bps, fixed_minor, margin_minor, effective_from, reason)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '1 day', 'edge')`,
      [rate, fixed, margin],
    );
});
