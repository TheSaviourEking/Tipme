import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  endOfLagosDayIso,
  lagosDayStart,
  newTotpSecret,
  totpAt,
} from '@tipme/domain';
import {
  approveRequest,
  checkedFeeWaiverPayload,
  createPaymentIntent,
  currentEstimateOf,
  createQuote,
  ensureOwnerRole,
  estimateFeeWaiverMonthlyCost,
  feeWaiverFor,
  feeWaiverRules,
  latestRowOfKey,
  mailSealing,
  markAttemptInitiated,
  recordProviderEvent,
  registerRealSeriousActions,
  requestSeriousAction,
  sealSecret,
  setFeeWaiver,
} from '../../dist/index.js';
import { openTestDatabase } from '../../dist/test-support.js';
import { seedBusiness, seedManager } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Fee waivers (spec 2026-11-23 §4, plan Task 2): the append-only rule table and its reads. The
// switch carry-over (W15) and its reset seed came with Task 5 (pre-flight rulings R2, R3).

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

/** The fixed id of the business withdrawal rule carried over from the switch (W15, R3). */
const CARRIED_OVER = '00000000-0000-4000-8000-000000000130';

/** The carry-over migration's statements, as drizzle runs them. */
async function carryOverStatements() {
  const drizzle = new URL('../../drizzle/', import.meta.url);
  const [file] = (await readdir(drizzle)).filter((f) =>
    f.endsWith('_fee_waiver_carry_over.sql'),
  );
  assert.ok(file, 'the carry-over migration exists');
  return (await readFile(new URL(file, drizzle), 'utf8'))
    .split('--> statement-breakpoint')
    .filter((statement) => statement.trim() !== '');
}

const carriedOverAudit = (pool) =>
  pool
    .query(
      `SELECT staff_user_id, action, permission, subject_type, reason FROM audit_events
        WHERE subject_id = $1 ORDER BY created_at`,
      [CARRIED_OVER],
    )
    .then((r) => r.rows);

test('a freshly migrated database holds one business withdrawal rule carried over from the switch, payer account', async (t) => {
  // This process's own copy of the migrated template, read before any test resets it.
  const database = await openTestDatabase();
  t.after(() => database.close());
  const { rows } = await database.pool.query(
    `SELECT id, scope, kind, profile_id, business_id, fee, payer, ends_at, reason, set_by, approved_by
       FROM fee_waivers`,
  );
  assert.deepEqual(rows, [
    {
      id: CARRIED_OVER,
      scope: 'kind',
      kind: 'business',
      profile_id: null,
      business_id: null,
      fee: 'withdrawal',
      payer: 'account',
      ends_at: null,
      reason: 'Carried over from the switch',
      set_by: null,
      approved_by: null,
    },
  ]);
  const audit = await carriedOverAudit(database.pool);
  assert.equal(audit.length, 1);
  assert.deepEqual(
    { ...audit[0], reason: undefined },
    {
      staff_user_id: null,
      action: 'fee_waiver.set',
      permission: 'fees.manage',
      subject_type: 'fee_waiver',
      reason: undefined,
    },
  );
  assert.match(
    audit[0].reason,
    /^Carried over from the switch \[change: \{.*"from":\{"switch":"business_payout_fee_absorbed","on":false\},"to":\{"payer":"account"/,
  );
  // A business follows today's rule under it: it pays its own fee.
  assert.equal(
    (
      await feeWaiverFor(database.db, {
        owner: { businessId: randomUUID() },
        fee: 'withdrawal',
        now: new Date(Date.now() + 1000),
      })
    ).payer,
    'default',
  );
});

test('re-running the carry-over with the switch row on writes payer tipme; a second run adds nothing', async (t) => {
  const db = await setup(t);
  // Only the rules and the audit, with the test opt-in: both are history and refuse it otherwise.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL tipme.allow_truncate = 'on'`);
    await client.query('TRUNCATE fee_waivers, audit_events CASCADE');
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await db.pool.query(
    `INSERT INTO feature_switches (key, enabled, source, changed_at, reason)
     VALUES ('business_payout_fee_absorbed', true, 'staff', now(), 'On before the retirement')`,
  );
  for (let run = 0; run < 2; run += 1)
    for (const statement of await carryOverStatements())
      await db.pool.query(statement);
  const { rows } = await db.pool.query(
    `SELECT id, payer, reason FROM fee_waivers`,
  );
  assert.deepEqual(rows, [
    {
      id: CARRIED_OVER,
      payer: 'tipme',
      reason: 'Carried over from the switch',
    },
  ]);
  const audit = await carriedOverAudit(db.pool);
  assert.equal(audit.length, 1);
  assert.match(audit[0].reason, /"on":true\},"to":\{"payer":"tipme"/);
  const decided = await feeWaiverFor(db.db, {
    owner: { businessId: randomUUID() },
    fee: 'withdrawal',
    now: new Date(Date.now() + 1000),
  });
  assert.deepEqual(
    { payer: decided.payer, ruleId: decided.ruleId },
    { payer: 'tipme', ruleId: CARRIED_OVER },
  );
});

test('the test reset seeds the carried-over rule as the migration writes it', async (t) => {
  const db = await setup(t);
  const { rows } = await db.pool.query(
    `SELECT id, scope, kind, fee, payer, reason, set_by FROM fee_waivers`,
  );
  assert.deepEqual(rows, [
    {
      id: CARRIED_OVER,
      scope: 'kind',
      kind: 'business',
      fee: 'withdrawal',
      payer: 'account',
      reason: 'Carried over from the switch',
      set_by: null,
    },
  ]);
  assert.equal((await carriedOverAudit(db.pool)).length, 1);
});

test('the rules table is history: rows cannot be updated, deleted or truncated', async (t) => {
  const db = await setup(t);
  const id = await insertRule(db);
  // The triggers' own messages (tipme_forbid_mutation, tipme_forbid_truncate), not any error.
  await refusal(
    db.pool.query(`UPDATE fee_waivers SET reason = 'changed' WHERE id = $1`, [
      id,
    ]),
    /append-only table fee_waivers: UPDATE is not allowed/,
  );
  await refusal(
    db.pool.query(`DELETE FROM fee_waivers WHERE id = $1`, [id]),
    /append-only table fee_waivers: DELETE is not allowed/,
  );
  await refusal(
    db.pool.query(`TRUNCATE fee_waivers CASCADE`),
    /append-only table fee_waivers: TRUNCATE is not allowed/,
  );
  // This row and the reset's carried-over business rule.
  assert.equal(await db.count('fee_waivers'), 2);
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
  // Only the reset's carried-over business rule.
  assert.equal(await db.count('fee_waivers'), 1);
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
  // These three and the reset's carried-over business rule.
  assert.equal(await db.count('fee_waivers'), 4);
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
  // Only the reset's carried-over business rule is left in force.
  const { inForce } = await feeWaiverRules(db.db, { now: NOW });
  assert.deepEqual(
    inForce.map((r) => r.id),
    [CARRIED_OVER],
  );
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
    [current, businessCurrent, CARRIED_OVER].sort(),
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
    business.inForce.map((r) => r.id).sort(),
    [businessCurrent, CARRIED_OVER].sort(),
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
  // And it binds: a waived fee with no rule is refused; with its rule it is kept.
  const payout = (feeWaiverId, waivedFeeMinor) =>
    db.pool.query(
      `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                            request_fingerprint, fee_waiver_id, waived_fee_minor)
       VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'fp', $4, $5)`,
      [randomUUID(), ADA, randomUUID(), feeWaiverId, waivedFeeMinor],
    );
  await refusal(payout(null, 5000), /payouts_waived_fee/);
  await refusal(payout(rule, -1), /payouts_waived_fee/);
  await payout(rule, 5000);

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

// --- Setting a waiver: the serious action `fee_waiver.set` (plan Task 3) ---

const TOTP_KEY = randomBytes(32);
const services = () => ({
  sealing: mailSealing(randomBytes(32)),
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});
const REASON = 'Waiver agreed with the partner team today';
const DAY = 24 * HOUR;

/** Staff with a confirmed authenticator and a fresh ops grant, as the API's own tests make them. */
async function staffPerson(db, people) {
  const q = (text, values) =>
    db.pool.query(text, values).then((result) => result.rows);
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`fw.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [id],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [id, sealSecret(TOTP_KEY, secret)],
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

async function actionSetup(t) {
  const db = await setup(t);
  await ensureOwnerRole(db.db);
  registerRealSeriousActions();
  const people = new Map();
  const person = () => staffPerson(db, people);
  const ask = (actorId, payload, now = undefined) =>
    requestSeriousAction(db.db, {
      name: 'fee_waiver.set',
      payload,
      actorId,
      grantId: people.get(actorId).grantId,
      reason: REASON,
      services: services(),
      ...(now ? { now } : {}),
    });
  const approve = (requestId, actorId, now = new Date()) =>
    approveRequest(db.db, {
      requestId,
      actorId,
      code: totpAt(
        people.get(actorId).secret,
        BigInt(Math.floor(now.getTime() / 30_000)),
      ),
      key: TOTP_KEY,
      now,
      services: services(),
    });
  const set = (input, now = new Date()) =>
    db.db.transaction((tx) =>
      setFeeWaiver(tx, {
        staffUserId: null,
        approvedBy: null,
        reason: 'Set directly for the test',
        now,
        ...input,
      }),
    );
  // The rows each test writes: the reset's carried-over business rule (tested above) aside.
  const rows = () =>
    db.pool
      .query(
        `SELECT * FROM fee_waivers WHERE id <> $1 ORDER BY created_at, starts_at`,
        [CARRIED_OVER],
      )
      .then((r) => r.rows);
  return { db, person, people, ask, approve, set, rows };
}

/**
 * The estimate covers whole Lagos days up to today's start, so what was paid today counts from
 * tomorrow. Moves every tip and withdrawal so far back a day, into the window.
 */
async function intoYesterday(db) {
  await db.pool.query(
    `UPDATE tips SET completed_at = completed_at - interval '1 day' WHERE completed_at IS NOT NULL`,
  );
  await db.pool.query(
    `UPDATE payouts SET created_at = created_at - interval '1 day'`,
  );
}

/** The asker's last code, entered at `at`: a request made then has a fresh code. */
const codeEnteredAt = (db, people, actor, at) =>
  db.pool.query(
    `UPDATE ops_sessions SET last_totp_at = $2, expires_at = $2::timestamptz + interval '1 hour'
      WHERE id = $1`,
    [people.get(actor).grantId, at],
  );

/** 00:30 tomorrow in Lagos. */
const lagosTomorrow = () =>
  new Date(lagosDayStart(new Date()).getTime() + DAY + 30 * 60_000);

/** Moves the clock every `new Date()` reads (the database's own clock stays). */
const clockAt = (t, at) => {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: at.getTime() });
};

const adaTip = {
  scope: 'account',
  kind: 'individual',
  profileId: ADA,
  fee: 'tip',
};
/** The Lagos year now, and the `until 31 Jan` instant of the next one (always "31 Jan <year>"). */
const nextYear = () =>
  Number(new Date(Date.now() + HOUR).toISOString().slice(0, 4)) + 1;
const endOfJanNextYear = () => endOfLagosDayIso(`${nextYear()}-01-31`);

/** A paid pretend tip on a page, through the quote, intent and the partner's success event. */
async function paidTip(db, handle, tipMinor) {
  const quote = await createQuote(db.db, { handle, tipMinor, currency: 'NGN' });
  const intent = await createPaymentIntent(db.db, {
    quoteId: quote.quoteId,
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
    amountMinor: tipMinor,
    currency: 'NGN',
    providerFeeMinor: 15_000n,
    signatureVerified: true,
    payload: {},
  });
  return quote.breakdown.platformFeeMinor + quote.breakdown.providerFeeMinor;
}

async function seedPayout(
  db,
  { profileId = null, businessId = null, status = 'PAID', userFeeMinor },
) {
  await db.pool.query(
    `INSERT INTO payouts (id, profile_id, business_id, currency, amount_minor, status, idempotency_key,
                          request_fingerprint, fee_payer, user_fee_minor, paid_at)
     VALUES ($1, $2, $3, 'NGN', 100000, $4::payout_status, $5, 'fp', 'user', $6,
             CASE WHEN $4::text = 'PAID' THEN now() END)`,
    [randomUUID(), profileId, businessId, status, randomUUID(), userFeeMinor],
  );
}

const auditOf = async (db, id) =>
  (
    await db.pool.query(
      `SELECT staff_user_id, permission, reason FROM audit_events
        WHERE action = 'fee_waiver.set' AND subject_id = $1`,
      [id],
    )
  ).rows;

test('a second person approves; the row records set_by, approved_by and an audit with before and after', async (t) => {
  const { db, person, ask, approve, set, rows } = await actionSetup(t);
  const asker = await person();
  const approver = await person();
  // Before: TipMe pays Ada's tip fee with no end date.
  const before = await set({ ...adaTip, payer: 'tipme' });
  const endsAt = endOfJanNextYear();
  const outcome = await ask(asker, { ...adaTip, payer: 'tipme', endsAt });
  assert.equal(outcome.state, 'pending', JSON.stringify(outcome));
  const [request] = (
    await db.pool.query(`SELECT * FROM approval_requests WHERE id = $1`, [
      outcome.requestId,
    ])
  ).rows;
  assert.equal(request.permission, 'fees.manage');
  assert.equal(
    request.summary,
    `TipMe pays the tip fee for @ada until 31 Jan ${nextYear()}`,
  );
  // Nothing changes until it is approved.
  assert.equal((await rows()).length, 1);
  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  const stored = await rows();
  assert.equal(stored.length, 2);
  const row = stored[1];
  assert.equal(row.set_by, asker);
  assert.equal(row.approved_by, approver);
  assert.equal(row.payer, 'tipme');
  assert.equal(row.ends_at.toISOString(), endsAt);
  assert.equal(row.reason, REASON);
  const [audit] = await auditOf(db, row.id);
  assert.equal(audit.staff_user_id, asker);
  assert.equal(audit.permission, 'fees.manage');
  assert.ok(audit.reason.startsWith(REASON));
  assert.match(
    audit.reason,
    new RegExp(
      `"from":\\{"id":"${before.id}","payer":"tipme","startsAt":"[^"]+","endsAt":null\\}`,
    ),
  );
  assert.match(
    audit.reason,
    new RegExp(
      `"to":\\{"payer":"tipme","startsAt":"[^"]+","endsAt":"${endsAt}"\\}`,
    ),
  );
  assert.match(audit.reason, new RegExp(`"approvedBy":"${approver}"`));
  const now = await feeWaiverFor(db.db, {
    owner: { profileId: ADA },
    fee: 'tip',
    now: new Date(),
  });
  assert.deepEqual([now.payer, now.ruleId], ['tipme', row.id]);
});

test('a lone admin acts alone and the owners are alerted', async (t) => {
  const { db, person, ask, rows } = await actionSetup(t);
  const lone = await person();
  const outcome = await ask(lone, { ...adaTip, payer: 'tipme' });
  assert.equal(outcome.state, 'ran', JSON.stringify(outcome));
  assert.equal(outcome.aloneReason, 'no_second_person');
  const [row] = await rows();
  assert.equal(row.set_by, lone);
  assert.equal(row.approved_by, null);
  assert.equal(
    (
      await db.pool.query(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).rows.length,
    1,
  );
  const [audit] = await auditOf(db, row.id);
  assert.match(audit.reason, /"from":null/);
  assert.match(audit.reason, /"approvedBy":null/);
});

test('a request overtaken by another change to the same key is refused as stale', async (t) => {
  const { person, ask, approve, set, rows } = await actionSetup(t);
  const asker = await person();
  const approver = await person();
  const { requestId } = await ask(asker, { ...adaTip, payer: 'tipme' });
  // Meanwhile another change to Ada's tip-fee key, even one not started yet (W10).
  const meanwhile = await set({
    ...adaTip,
    payer: 'account',
    startsAt: new Date(Date.now() + DAY).toISOString(),
  });
  const outcome = await approve(requestId, approver);
  assert.equal(outcome.status, 'stale', JSON.stringify(outcome));
  assert.deepEqual(
    (await rows()).map((r) => r.id),
    [meanwhile.id],
  );
});

test('a change to another key does not make a waiting request stale', async (t) => {
  const { person, ask, approve, set } = await actionSetup(t);
  const asker = await person();
  const approver = await person();
  const { requestId } = await ask(asker, { ...adaTip, payer: 'tipme' });
  await set({ ...adaTip, fee: 'withdrawal', payer: 'tipme' });
  await set({ ...adaTip, profileId: TOBI, payer: 'tipme' });
  assert.equal((await approve(requestId, approver)).status, 'approved');
});

test('a waiver approved after its requested start begins at approval', async (t) => {
  const { person, ask, approve, rows } = await actionSetup(t);
  const asker = await person();
  const approver = await person();
  const start = new Date(Date.now() + 60_000);
  const { requestId } = await ask(asker, {
    ...adaTip,
    fee: 'withdrawal',
    payer: 'tipme',
    startsAt: start.toISOString(),
  });
  const approvedAt = new Date(start.getTime() + 3 * HOUR);
  // Everything that reads the time reads the approval's, so the words can't depend on it.
  clockAt(t, approvedAt);
  const outcome = await approve(requestId, approver, approvedAt);
  assert.equal(outcome.status, 'approved', JSON.stringify(outcome));
  const [row] = await rows();
  assert.equal(row.starts_at.toISOString(), approvedAt.toISOString());
});

test('a request made on 31 Dec for "until 31 Jan" is approved on 1 Jan: the words keep the year', async (t) => {
  const { db, person, people, ask, approve, rows } = await actionSetup(t);
  const asker = await person();
  const approver = await person();
  // 23:30 on 31 Dec in Lagos; the asker's code was entered just then.
  const askedAt = new Date(`${nextYear() - 1}-12-31T22:30:00.000Z`);
  await db.pool.query(
    `UPDATE ops_sessions SET last_totp_at = $2, expires_at = $2::timestamptz + interval '1 hour'
      WHERE id = $1`,
    [people.get(asker).grantId, askedAt],
  );
  clockAt(t, askedAt);
  const endsAt = endOfJanNextYear();
  const outcome = await ask(
    asker,
    { ...adaTip, payer: 'tipme', endsAt },
    askedAt,
  );
  assert.equal(outcome.state, 'pending', JSON.stringify(outcome));
  const [request] = (
    await db.pool.query(`SELECT summary FROM approval_requests WHERE id = $1`, [
      outcome.requestId,
    ])
  ).rows;
  assert.equal(
    request.summary,
    `TipMe pays the tip fee for @ada until 31 Jan ${nextYear()}`,
  );
  // 01:30 on 1 Jan in Lagos: now the same year as the end.
  const approvedAt = new Date(askedAt.getTime() + 2 * HOUR);
  clockAt(t, approvedAt);
  const approved = await approve(outcome.requestId, approver, approvedAt);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  assert.equal((await rows())[0].ends_at.toISOString(), endsAt);
});

test('the words name a requested start with its year, and the figure the asker saw', async (t) => {
  const { db, person, ask } = await actionSetup(t);
  const asker = await person();
  await person();
  const start = endOfLagosDayIso(`${nextYear()}-01-04`);
  const outcome = await ask(asker, {
    ...adaTip,
    payer: 'tipme',
    startsAt: start,
    endsAt: endOfJanNextYear(),
  });
  const [request] = (
    await db.pool.query(`SELECT summary FROM approval_requests WHERE id = $1`, [
      outcome.requestId,
    ])
  ).rows;
  assert.equal(
    request.summary,
    `TipMe pays the tip fee for @ada from 5 Jan ${nextYear()} (or on approval, if later) until 31 Jan ${nextYear()}`,
  );
});

const KIND_TIP = {
  scope: 'kind',
  kind: 'individual',
  fee: 'tip',
  payer: 'tipme',
  confirmCost: true,
};

test('a tip completing today leaves today’s estimate, and an approval keeps the asker’s figure', async (t) => {
  const { db, person, ask, approve, rows } = await actionSetup(t);
  const asker = await person();
  const approver = await person();
  await paidTip(db, 'ada', 1_000_000n);
  await intoYesterday(db);
  const payload = { ...KIND_TIP, costEstimateMinor: '50000' };
  // A figure that isn't the live one is not a confirm of it.
  await assert.rejects(
    ask(asker, { ...payload, costEstimateMinor: '40000' }),
    (error) => error.code === 'FEE_WAIVER_CONFIRM_REQUIRED',
  );
  // A tip today doesn't move today's figure, so the screen's figure still holds.
  await paidTip(db, 'ada', 1_000_000n);
  const estimate = (now) =>
    estimateFeeWaiverMonthlyCost(db.db, {
      kind: 'individual',
      fee: 'tip',
      now,
    });
  assert.equal(await estimate(new Date()), 50_000n);
  const outcome = await ask(asker, payload);
  assert.equal(outcome.state, 'pending', JSON.stringify(outcome));
  // Tomorrow the live figure is ₦1,000; the approver confirms the ₦500 they read.
  const approvedAt = lagosTomorrow();
  assert.equal(await estimate(approvedAt), 100_000n);
  clockAt(t, approvedAt);
  const approved = await approve(outcome.requestId, approver, approvedAt);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  assert.equal((await rows()).length, 1);
});

test('across Lagos midnight the refusal carries the new figure, and asking on it goes through', async (t) => {
  const { db, person, people, ask, rows } = await actionSetup(t);
  const lone = await person();
  await paidTip(db, 'ada', 1_000_000n);
  // The screen loaded today, when the tip wasn't counted yet; the code is entered after midnight.
  const askedAt = lagosTomorrow();
  await codeEnteredAt(db, people, lone, askedAt);
  clockAt(t, askedAt);
  let refusal;
  await assert.rejects(
    ask(lone, { ...KIND_TIP, costEstimateMinor: '0' }, askedAt),
    (error) => {
      refusal = error;
      return error.code === 'FEE_WAIVER_CONFIRM_REQUIRED';
    },
  );
  assert.equal(currentEstimateOf(refusal), 50_000n);
  assert.equal(currentEstimateOf(new Error('other')), null);
  assert.equal((await rows()).length, 0);
  const outcome = await ask(
    lone,
    { ...KIND_TIP, costEstimateMinor: '50000' },
    askedAt,
  );
  assert.equal(outcome.state, 'ran', JSON.stringify(outcome));
});

test('two staff asking for the same rule the same day share one request; across midnight the pin keeps one', async (t) => {
  const { db, person, people, ask, approve, rows } = await actionSetup(t);
  const a = await person();
  const b = await person();
  const c = await person();
  await paidTip(db, 'ada', 1_000_000n);
  await intoYesterday(db);
  const first = await ask(a, { ...KIND_TIP, costEstimateMinor: '50000' });
  const again = await ask(b, { ...KIND_TIP, costEstimateMinor: '50000' });
  assert.equal(again.repeat, true);
  assert.equal(again.requestId, first.requestId);
  // After midnight today's tip counts: different words, so a request of its own for the approver
  // to read. Both pin the key's same latest row, so approving one makes the other stale.
  await paidTip(db, 'ada', 1_000_000n);
  const tomorrow = lagosTomorrow();
  await codeEnteredAt(db, people, b, tomorrow);
  clockAt(t, tomorrow);
  const later = await ask(
    b,
    { ...KIND_TIP, costEstimateMinor: '100000' },
    tomorrow,
  );
  assert.equal(later.state, 'pending');
  assert.notEqual(later.requestId, first.requestId);
  assert.equal(
    (await approve(first.requestId, c, tomorrow)).status,
    'approved',
  );
  // The next code step: a code is used once.
  const nextStep = new Date(tomorrow.getTime() + 30_000);
  clockAt(t, nextStep);
  assert.equal((await approve(later.requestId, c, nextStep)).status, 'stale');
  assert.equal((await rows()).length, 1);
});

test('an end date more than 24 months ahead, or before the start, is refused and stores nothing', async (t) => {
  const { db, person, ask, set, rows } = await actionSetup(t);
  const lone = await person();
  const now = Date.now();
  for (const window of [
    { endsAt: new Date(now + 25 * 31 * DAY).toISOString() },
    { endsAt: new Date(now - HOUR).toISOString() },
    {
      startsAt: new Date(now + 2 * DAY).toISOString(),
      endsAt: new Date(now + DAY).toISOString(),
    },
    { startsAt: new Date(now + 25 * 31 * DAY).toISOString() },
  ]) {
    await assert.rejects(
      ask(lone, { ...adaTip, payer: 'tipme', ...window }),
      (error) => error.code === 'INVALID_INPUT',
      JSON.stringify(window),
    );
    await assert.rejects(
      set({ ...adaTip, payer: 'tipme', ...window }),
      (error) => error.code === 'INVALID_INPUT',
      JSON.stringify(window),
    );
  }
  assert.equal((await rows()).length, 0);
  assert.equal(await db.count('approval_requests'), 0);
});

test('a kind-wide TipMe-pays waiver needs confirmCost, and its description names the estimate', async (t) => {
  const { db, person, ask, rows } = await actionSetup(t);
  const asker = await person();
  await person();
  // Two paid tips on Ada's page (₦10,000 at Free 5%: ₦500 each) and one user-paid withdrawal (₦50).
  const shares = [
    await paidTip(db, 'ada', 1_000_000n),
    await paidTip(db, 'ada', 1_000_000n),
  ];
  assert.deepEqual(shares, [50_000n, 50_000n]);
  await seedPayout(db, { profileId: ADA, userFeeMinor: 5_000n });
  // Not counted: a failed withdrawal's fee, and a business's withdrawal for an individual estimate.
  await seedPayout(db, {
    profileId: ADA,
    status: 'FAILED',
    userFeeMinor: 9_900n,
  });
  const { businessId } = await seedBusiness(db);
  await seedPayout(db, { businessId, userFeeMinor: 7_500n });
  await intoYesterday(db);
  // Today's tips count from tomorrow: this one leaves today's figure.
  await paidTip(db, 'ada', 1_000_000n);

  const now = new Date();
  // The tip-fee figure is the tips' fees; the withdrawal-fee figure is the payouts' user fees.
  assert.equal(
    await estimateFeeWaiverMonthlyCost(db.db, {
      kind: 'individual',
      fee: 'tip',
      now,
    }),
    100_000n,
  );
  assert.equal(
    await estimateFeeWaiverMonthlyCost(db.db, {
      kind: 'individual',
      fee: 'withdrawal',
      now,
    }),
    5_000n,
  );
  assert.equal(
    await estimateFeeWaiverMonthlyCost(db.db, {
      kind: 'business',
      fee: 'withdrawal',
      now,
    }),
    7_500n,
  );
  assert.equal(
    await estimateFeeWaiverMonthlyCost(db.db, {
      kind: 'giving',
      fee: 'withdrawal',
      now,
    }),
    0n,
  );
  // 31 days on, none of it is in the last 30 days.
  assert.equal(
    await estimateFeeWaiverMonthlyCost(db.db, {
      kind: 'individual',
      fee: 'tip',
      now: new Date(now.getTime() + 31 * DAY),
    }),
    0n,
  );

  const kindTip = {
    scope: 'kind',
    kind: 'individual',
    fee: 'tip',
    payer: 'tipme',
  };
  // Asked at request time: without the confirm nothing waits and nothing is stored.
  await assert.rejects(
    ask(asker, kindTip),
    (error) => error.code === 'FEE_WAIVER_CONFIRM_REQUIRED',
  );
  assert.equal(await db.count('approval_requests'), 0);
  // The confirm without the figure the asker saw is not enough either.
  await assert.rejects(
    ask(asker, { ...kindTip, confirmCost: true }),
    (error) => error.code === 'FEE_WAIVER_CONFIRM_REQUIRED',
  );
  const tip = await ask(asker, {
    ...kindTip,
    confirmCost: true,
    costEstimateMinor: '100000',
  });
  assert.equal(tip.state, 'pending', JSON.stringify(tip));
  const withdrawal = await ask(asker, {
    ...kindTip,
    fee: 'withdrawal',
    endsAt: endOfJanNextYear(),
    confirmCost: true,
    costEstimateMinor: '5000',
  });
  const summaries = (
    await db.pool.query(
      `SELECT id, summary FROM approval_requests WHERE id = ANY($1::uuid[])`,
      [[tip.requestId, withdrawal.requestId]],
    )
  ).rows;
  const summaryOf = (id) => summaries.find((r) => r.id === id).summary;
  assert.equal(
    summaryOf(tip.requestId),
    'TipMe pays the tip fee for all individuals, with no end date (about ₦1,000 a month, last 30 days)',
  );
  assert.equal(
    summaryOf(withdrawal.requestId),
    `TipMe pays the withdrawal fee for all individuals until 31 Jan ${nextYear()} (about ₦50 a month, last 30 days)`,
  );
  assert.equal((await rows()).length, 0);
  // A withdrawal TipMe already covered counts the fee it would have charged, once (W8: its user
  // fee is 0), so renewing a waiver does not read as free.
  const rule = await insertRule(db, {
    scope: 'account',
    profileId: ADA,
    fee: 'withdrawal',
    startsAt: new Date(Date.now() - DAY),
  });
  await db.pool.query(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                          request_fingerprint, fee_payer, user_fee_minor, fee_waiver_id, waived_fee_minor,
                          created_at)
     VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'fp', 'tipme', 0, $4, 2000,
             now() - interval '1 day')`,
    [randomUUID(), ADA, randomUUID(), rule],
  );
  assert.equal(
    await estimateFeeWaiverMonthlyCost(db.db, {
      kind: 'individual',
      fee: 'withdrawal',
      now: new Date(),
    }),
    7_000n,
  );
});

test('setFeeWaiver refuses a kind-wide TipMe-pays rule without confirmCost', async (t) => {
  const { db, set, rows } = await actionSetup(t);
  const kindTip = {
    scope: 'kind',
    kind: 'individual',
    fee: 'tip',
    payer: 'tipme',
  };
  await assert.rejects(
    set(kindTip),
    (error) => error.code === 'FEE_WAIVER_CONFIRM_REQUIRED',
  );
  // The confirm names the figure confirmed; without it there is nothing confirmed.
  await assert.rejects(
    set({ ...kindTip, confirmCost: true }),
    (error) => error.code === 'FEE_WAIVER_CONFIRM_REQUIRED',
  );
  assert.equal((await rows()).length, 0);
  const { id } = await set({
    ...kindTip,
    confirmCost: true,
    costEstimateMinor: '0',
  });
  assert.equal((await rows()).length, 1);
  const [audit] = await auditOf(db, id);
  assert.match(audit.reason, /"costEstimateMinor":"0"/);
});

test('ending a waiver now writes inherit (account) or account (kind)', async (t) => {
  const { db, set } = await actionSetup(t);
  const payerNow = async (fee) =>
    (
      await feeWaiverFor(db.db, {
        owner: { profileId: ADA },
        fee,
        now: new Date(),
      })
    ).payer;
  await set({ ...adaTip, payer: 'tipme' });
  assert.equal(await payerNow('tip'), 'tipme');
  // The same rule again changes nothing, so it is refused.
  await assert.rejects(
    set({ ...adaTip, payer: 'tipme' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  const ended = await set({ ...adaTip, payer: 'inherit' });
  assert.equal(await payerNow('tip'), 'default');
  const adaKey = {
    scope: 'account',
    kind: 'individual',
    owner: { profileId: ADA },
    fee: 'tip',
  };
  assert.equal((await latestRowOfKey(db.db, adaKey)).id, ended.id);
  assert.equal((await latestRowOfKey(db.db, adaKey)).payer, 'inherit');

  const kindWithdrawal = {
    scope: 'kind',
    kind: 'individual',
    fee: 'withdrawal',
  };
  await set({
    ...kindWithdrawal,
    payer: 'tipme',
    confirmCost: true,
    costEstimateMinor: '0',
  });
  assert.equal(await payerNow('withdrawal'), 'tipme');
  await assert.rejects(
    set({ ...kindWithdrawal, payer: 'inherit' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await set({ ...kindWithdrawal, payer: 'account' });
  assert.equal(await payerNow('withdrawal'), 'default');
  assert.equal((await latestRowOfKey(db.db, kindWithdrawal)).payer, 'account');
  // Ending what has no rule changes nothing.
  await assert.rejects(
    set({ ...adaTip, profileId: TOBI, payer: 'inherit' }),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('a Giving account waiver is refused', async (t) => {
  const { db, person, ask, set, rows } = await actionSetup(t);
  const lone = await person();
  const giving = {
    scope: 'account',
    kind: 'giving',
    profileId: ADA,
    fee: 'withdrawal',
    payer: 'tipme',
  };
  assert.throws(
    () => checkedFeeWaiverPayload(giving),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    ask(lone, giving),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(set(giving), (error) => error.code === 'INVALID_INPUT');
  assert.equal((await rows()).length, 0);
  assert.equal(await db.count('approval_requests'), 0);
  // A kind-wide Giving rule can be set now (§8); its estimate is 0.
  const outcome = await ask(lone, {
    scope: 'kind',
    kind: 'giving',
    fee: 'withdrawal',
    payer: 'tipme',
    confirmCost: true,
    costEstimateMinor: '0',
  });
  assert.equal(outcome.state, 'ran', JSON.stringify(outcome));
});

test('the payload is checked: shapes, ids, instants and unknown fields', () => {
  const bad = [
    null,
    'x',
    {},
    { ...adaTip, payer: 'someone' },
    { ...adaTip, payer: 'tipme', scope: 'everyone' },
    { ...adaTip, payer: 'tipme', fee: 'payout' },
    { ...adaTip, payer: 'tipme', kind: 'charity' },
    { ...adaTip, payer: 'tipme', profileId: 'not-a-uuid' },
    { ...adaTip, payer: 'tipme', profileId: undefined },
    { ...adaTip, payer: 'tipme', businessId: randomUUID() },
    { ...adaTip, payer: 'tipme', kind: 'business' },
    { scope: 'kind', kind: 'individual', fee: 'tip', payer: 'inherit' },
    {
      scope: 'kind',
      kind: 'individual',
      fee: 'tip',
      payer: 'tipme',
      profileId: ADA,
    },
    { scope: 'kind', kind: 'business', fee: 'tip', payer: 'tipme' },
    { ...adaTip, payer: 'tipme', endsAt: 'tomorrow' },
    { ...adaTip, payer: 'tipme', startsAt: 42 },
    { ...adaTip, payer: 'tipme', confirmCost: false },
    {
      scope: 'kind',
      kind: 'individual',
      fee: 'tip',
      payer: 'tipme',
      confirmCost: true,
      costEstimateMinor: '-1',
    },
    {
      scope: 'kind',
      kind: 'individual',
      fee: 'tip',
      payer: 'tipme',
      confirmCost: true,
      costEstimateMinor: '1.5',
    },
    {
      scope: 'kind',
      kind: 'individual',
      fee: 'tip',
      payer: 'tipme',
      confirmCost: true,
      costEstimateMinor: 500,
    },
    {
      scope: 'kind',
      kind: 'individual',
      fee: 'tip',
      payer: 'tipme',
      costEstimateMinor: '500',
    },
    // A figure only where it is checked: a kind-wide TipMe-pays rule.
    { ...adaTip, payer: 'tipme', confirmCost: true, costEstimateMinor: '0' },
    {
      scope: 'kind',
      kind: 'individual',
      fee: 'tip',
      payer: 'account',
      confirmCost: true,
      costEstimateMinor: '0',
    },
    { ...adaTip, payer: 'tipme', extra: 1 },
  ];
  for (const payload of bad)
    assert.throws(
      () => checkedFeeWaiverPayload(payload),
      (error) => error.code === 'INVALID_INPUT',
      JSON.stringify(payload),
    );
  const businessId = randomUUID();
  assert.deepEqual(
    checkedFeeWaiverPayload({
      scope: 'account',
      kind: 'business',
      businessId,
      fee: 'withdrawal',
      payer: 'account',
      endsAt: '2027-02-01T00:00:00+01:00',
    }),
    {
      scope: 'account',
      kind: 'business',
      businessId,
      fee: 'withdrawal',
      payer: 'account',
      endsAt: '2027-01-31T23:00:00.000Z',
    },
  );
});

test('a business waiver names every manager, past ones included, as its subjects (R12)', async (t) => {
  const { db, person, ask, set } = await actionSetup(t);
  const { businessId, locations } = await seedBusiness(db);
  const pastManager = await person();
  await seedManager(db, {
    businessId,
    userId: pastManager,
    locationId: locations[0].id,
  });
  await db.pool.query(
    `UPDATE business_managers SET removed_at = now() WHERE user_id = $1`,
    [pastManager],
  );
  const payload = {
    scope: 'account',
    kind: 'business',
    businessId,
    fee: 'withdrawal',
    payer: 'tipme',
  };
  await assert.rejects(
    ask(pastManager, payload),
    (error) => error.code === 'APPROVAL_SUBJECT',
  );
  // An unknown business is refused, and so is an unknown page.
  await assert.rejects(
    set({ ...payload, businessId: randomUUID() }),
    (error) => error.code === 'BUSINESS_NOT_FOUND',
  );
  await assert.rejects(
    set({ ...adaTip, profileId: randomUUID(), payer: 'tipme' }),
    (error) => error.code === 'PROFILE_NOT_FOUND',
  );
  const other = await person();
  const outcome = await ask(other, payload);
  assert.equal(outcome.state, 'ran', JSON.stringify(outcome));
  const now = await feeWaiverFor(db.db, {
    owner: { businessId },
    fee: 'withdrawal',
    now: new Date(),
  });
  assert.equal(now.payer, 'tipme');
});
