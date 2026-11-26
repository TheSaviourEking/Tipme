import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  feeWaiverFor,
  feeWaiverRules,
  latestRowOfKey,
} from '../../dist/index.js';
import { seedBusiness } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Fee waivers (spec 2026-11-23 §4, plan Task 2): the append-only rule table and its reads. The
// switch carry-over and its reset seed belong to Task 5 (pre-flight ruling R2).

const HOUR = 3_600_000;
const NOW = new Date('2026-12-10T12:00:00.000Z');
const at = (hours) => new Date(NOW.getTime() + hours * HOUR);

/** Inserts one rule row straight into the table; `createdAt` defaults to `startsAt`. */
async function insertRule(
  db,
  {
    scope = 'kind',
    kind = 'individual',
    profileId = null,
    businessId = null,
    fee = 'tip',
    payer = 'tipme',
    startsAt = at(-24),
    endsAt = null,
    reason = 'Test rule',
    createdAt = startsAt,
  } = {},
) {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at,
       ends_at, reason, set_by, approved_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, $11)`,
    [
      id,
      scope,
      kind,
      profileId,
      businessId,
      fee,
      payer,
      startsAt,
      endsAt,
      reason,
      createdAt,
    ],
  );
  return id;
}

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  return db;
}

const refusal = async (promise, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.match(`${error.message} ${error.constraint ?? ''}`, pattern);
    return true;
  });
};

test('the rules table is history: rows cannot be updated, deleted or truncated', async (t) => {
  const db = await setup(t);
  const id = await insertRule(db);
  await assert.rejects(
    db.pool.query(`UPDATE fee_waivers SET reason = 'changed' WHERE id = $1`, [
      id,
    ]),
  );
  await assert.rejects(
    db.pool.query(`DELETE FROM fee_waivers WHERE id = $1`, [id]),
  );
  await assert.rejects(db.pool.query(`TRUNCATE fee_waivers CASCADE`));
  assert.equal(await db.count('fee_waivers'), 1);
});

test('the table refuses inherit on a kind rule, a business tip rule, and an end before the start', async (t) => {
  const db = await setup(t);
  const { businessId } = await seedBusiness(db);
  await refusal(
    insertRule(db, { scope: 'kind', payer: 'inherit' }),
    /fee_waivers_inherit/,
  );
  await refusal(
    insertRule(db, {
      scope: 'account',
      kind: 'business',
      businessId,
      fee: 'tip',
    }),
    /fee_waivers_business_tip/,
  );
  await refusal(
    insertRule(db, { startsAt: at(0), endsAt: at(0) }),
    /fee_waivers_window/,
  );
  await refusal(insertRule(db, { reason: '' }), /fee_waivers_reason/);
  // The account must match the kind: a person's rule names a page, a business's a business.
  await refusal(
    insertRule(db, { scope: 'account', kind: 'individual', businessId }),
    /fee_waivers_account/,
  );
  await refusal(
    insertRule(db, { scope: 'kind', profileId: ADA }),
    /fee_waivers_account/,
  );
  await refusal(
    insertRule(db, { scope: 'account', kind: 'giving', profileId: ADA }),
    /fee_waivers_account/,
  );
  await refusal(insertRule(db, { payer: 'nobody' }), /fee_waivers_payer/);
  assert.equal(await db.count('fee_waivers'), 0);
  // The shapes the table does allow.
  await insertRule(db, {
    scope: 'account',
    kind: 'individual',
    profileId: ADA,
    payer: 'inherit',
  });
  await insertRule(db, {
    scope: 'account',
    kind: 'business',
    businessId,
    fee: 'withdrawal',
  });
  await insertRule(db, { kind: 'giving', fee: 'withdrawal' });
  assert.equal(await db.count('fee_waivers'), 3);
});

test('an account rule beats a kind rule, read from the database', async (t) => {
  const db = await setup(t);
  assert.deepEqual(
    await feeWaiverFor(db.db, {
      owner: { profileId: ADA },
      fee: 'tip',
      now: NOW,
    }),
    { payer: 'default', ruleId: null, endsAt: null },
  );
  const kindRule = await insertRule(db, { payer: 'tipme', endsAt: at(48) });
  assert.deepEqual(
    await feeWaiverFor(db.db, {
      owner: { profileId: ADA },
      fee: 'tip',
      now: NOW,
    }),
    { payer: 'tipme', ruleId: kindRule, endsAt: at(48) },
  );
  // Ada's own rule (no end) wins over the kind's; Tobi still follows the kind; the withdrawal fee
  // is another key.
  const adaRule = await insertRule(db, {
    scope: 'account',
    profileId: ADA,
    payer: 'tipme',
  });
  assert.deepEqual(
    await feeWaiverFor(db.db, {
      owner: { profileId: ADA },
      fee: 'tip',
      now: NOW,
    }),
    { payer: 'tipme', ruleId: adaRule, endsAt: null },
  );
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: TOBI },
        fee: 'tip',
        now: NOW,
      })
    ).ruleId,
    kindRule,
  );
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: ADA },
        fee: 'withdrawal',
        now: NOW,
      })
    ).payer,
    'default',
  );
  // A business reads the business kind rule, never the individual one.
  const { businessId } = await seedBusiness(db);
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { businessId },
        fee: 'withdrawal',
        now: NOW,
      })
    ).payer,
    'default',
  );
  const businessRule = await insertRule(db, {
    kind: 'business',
    fee: 'withdrawal',
  });
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { businessId },
        fee: 'withdrawal',
        now: NOW,
      })
    ).ruleId,
    businessRule,
  );
});

test('payer account opts one account out; inherit follows the kind', async (t) => {
  const db = await setup(t);
  await insertRule(db, { payer: 'tipme' });
  await insertRule(db, {
    scope: 'account',
    profileId: ADA,
    payer: 'account',
    startsAt: at(-2),
  });
  assert.deepEqual(
    await feeWaiverFor(db.db, {
      owner: { profileId: ADA },
      fee: 'tip',
      now: NOW,
    }),
    { payer: 'default', ruleId: null, endsAt: null },
  );
  // A later inherit row hands Ada back to the kind rule.
  await insertRule(db, {
    scope: 'account',
    profileId: ADA,
    payer: 'inherit',
    startsAt: at(-1),
  });
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: ADA },
        fee: 'tip',
        now: NOW,
      })
    ).payer,
    'tipme',
  );
});

test('a newer row that has ended leaves the key with no rule, never the older one', async (t) => {
  const db = await setup(t);
  // An older open-ended waiver, then a newer one that ended an hour ago.
  await insertRule(db, { payer: 'tipme', startsAt: at(-48) });
  await insertRule(db, { payer: 'tipme', startsAt: at(-24), endsAt: at(-1) });
  assert.deepEqual(
    await feeWaiverFor(db.db, {
      owner: { profileId: ADA },
      fee: 'tip',
      now: NOW,
    }),
    { payer: 'default', ruleId: null, endsAt: null },
  );
  const { inForce } = await feeWaiverRules(db.db, { now: NOW });
  assert.deepEqual(inForce, []);
  // The same for an account key: its ended row does not revive its older one, and the kind
  // (now ruleless) gives the default.
  await insertRule(db, {
    scope: 'account',
    profileId: TOBI,
    payer: 'tipme',
    fee: 'withdrawal',
    startsAt: at(-48),
  });
  await insertRule(db, {
    scope: 'account',
    profileId: TOBI,
    payer: 'tipme',
    fee: 'withdrawal',
    startsAt: at(-24),
    endsAt: at(-1),
  });
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: TOBI },
        fee: 'withdrawal',
        now: NOW,
      })
    ).payer,
    'default',
  );
});

test('upcoming rules are listed apart and not applied', async (t) => {
  const db = await setup(t);
  const { businessId } = await seedBusiness(db);
  const current = await insertRule(db, {
    payer: 'tipme',
    reason: 'December promotion',
  });
  const upcoming = await insertRule(db, {
    payer: 'account',
    startsAt: at(24),
    reason: 'Promotion ends',
  });
  const adaUpcoming = await insertRule(db, {
    scope: 'account',
    profileId: ADA,
    payer: 'tipme',
    fee: 'withdrawal',
    startsAt: at(5),
    endsAt: at(29),
  });
  const businessCurrent = await insertRule(db, {
    scope: 'account',
    kind: 'business',
    businessId,
    fee: 'withdrawal',
    payer: 'tipme',
  });
  // An older row of the same key as `current` is history, not in force.
  await insertRule(db, { payer: 'account', startsAt: at(-100) });

  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: ADA },
        fee: 'withdrawal',
        now: NOW,
      })
    ).payer,
    'default',
  );
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: ADA },
        fee: 'tip',
        now: NOW,
      })
    ).ruleId,
    current,
  );

  const all = await feeWaiverRules(db.db, { now: NOW });
  assert.deepEqual(
    all.inForce.map((r) => r.id).sort(),
    [current, businessCurrent].sort(),
  );
  assert.deepEqual(
    all.upcoming.map((r) => r.id),
    [adaUpcoming, upcoming],
  );
  const row = all.inForce.find((r) => r.id === current);
  assert.deepEqual(
    {
      scope: row.scope,
      kind: row.kind,
      accountId: row.accountId,
      fee: row.fee,
      payer: row.payer,
      endsAt: row.endsAt,
      reason: row.reason,
      setBy: row.setBy,
      approvedBy: row.approvedBy,
    },
    {
      scope: 'kind',
      kind: 'individual',
      accountId: null,
      fee: 'tip',
      payer: 'tipme',
      endsAt: null,
      reason: 'December promotion',
      setBy: null,
      approvedBy: null,
    },
  );
  assert.equal(
    all.inForce.find((r) => r.id === businessCurrent).accountId,
    businessId,
  );

  // Filters: by kind, and by one account (its own rules only).
  const business = await feeWaiverRules(db.db, {
    now: NOW,
    filter: { kind: 'business' },
  });
  assert.deepEqual(
    business.inForce.map((r) => r.id),
    [businessCurrent],
  );
  assert.deepEqual(business.upcoming, []);
  const ada = await feeWaiverRules(db.db, {
    now: NOW,
    filter: { owner: { profileId: ADA } },
  });
  assert.deepEqual(ada.inForce, []);
  assert.deepEqual(
    ada.upcoming.map((r) => r.id),
    [adaUpcoming],
  );

  // Once its start passes, the upcoming row is the one applied.
  assert.equal(
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: ADA },
        fee: 'withdrawal',
        now: at(6),
      })
    ).ruleId,
    adaUpcoming,
  );
});

test('the latest row of a key includes an upcoming one (the approval pin)', async (t) => {
  const db = await setup(t);
  const kindKey = { scope: 'kind', kind: 'individual', fee: 'tip' };
  assert.equal(await latestRowOfKey(db.db, kindKey), null);
  await insertRule(db, { startsAt: at(-24) });
  const later = await insertRule(db, { payer: 'account', startsAt: at(24) });
  assert.equal((await latestRowOfKey(db.db, kindKey)).id, later);
  // Same start: the later created_at wins.
  const tie = await insertRule(db, {
    payer: 'tipme',
    startsAt: at(24),
    createdAt: at(25),
  });
  assert.equal((await latestRowOfKey(db.db, kindKey)).id, tie);
  // An account key is its own.
  const accountKey = {
    scope: 'account',
    kind: 'individual',
    owner: { profileId: ADA },
    fee: 'tip',
  };
  assert.equal(await latestRowOfKey(db.db, accountKey), null);
  const ada = await insertRule(db, {
    scope: 'account',
    profileId: ADA,
    payer: 'inherit',
  });
  const latest = await latestRowOfKey(db.db, accountKey);
  assert.equal(latest.id, ada);
  assert.equal(latest.accountId, ADA);
});

test('payouts and quotes record the rule; a waived fee needs its rule; notices are once per kind', async (t) => {
  const db = await setup(t);
  const rule = await insertRule(db);
  const { rows: columns } = await db.pool.query(
    `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
      WHERE (table_name, column_name) IN (('tip_quotes', 'fee_waiver_id'),
        ('payouts', 'fee_waiver_id'), ('payouts', 'waived_fee_minor'))
      ORDER BY table_name, column_name`,
  );
  assert.deepEqual(
    columns.map((c) => [c.table_name, c.column_name, c.is_nullable]),
    [
      ['payouts', 'fee_waiver_id', 'YES'],
      ['payouts', 'waived_fee_minor', 'NO'],
      ['tip_quotes', 'fee_waiver_id', 'YES'],
    ],
  );
  const { rows: checks } = await db.pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'payouts_waived_fee'`,
  );
  assert.equal(checks.length, 1);
  assert.match(checks[0].def, /waived_fee_minor >= 0/);
  assert.match(checks[0].def, /fee_waiver_id IS NOT NULL/);

  await db.pool.query(
    `INSERT INTO fee_waiver_notices (rule_id, kind) VALUES ($1, 'started'), ($1, 'ended')`,
    [rule],
  );
  await refusal(
    db.pool.query(
      `INSERT INTO fee_waiver_notices (rule_id, kind) VALUES ($1, 'started')`,
      [rule],
    ),
    /duplicate key/,
  );
  // The day-before notice is an issue with its own dedupe key (ruling R6), not a notices row.
  await refusal(
    db.pool.query(
      `INSERT INTO fee_waiver_notices (rule_id, kind) VALUES ($1, 'ending_soon')`,
      [rule],
    ),
    /fee_waiver_notices_kind/,
  );
  // The recipient's in-app notices.
  const { rows: kindCheck } = await db.pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'notifications_kind'`,
  );
  assert.match(kindCheck[0].def, /fee_waiver_started/);
  assert.match(kindCheck[0].def, /fee_waiver_ended/);
});
