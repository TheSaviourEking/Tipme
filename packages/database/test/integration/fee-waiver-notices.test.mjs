import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { endOfLagosDayIso } from '@tipme/domain';
import { DEMO_PROFILES, runFeeWaiverNotices } from '../../dist/index.js';
import { seedBusiness, seedManager } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Fee waivers, plan Task 8 (spec 2026-11-23 §5, §6; W13, W14; rulings R6, R11, R19): the account
// notices, the staff day-before issue and the low-balance pause alert, each once.

const ADA_USER = DEMO_PROFILES[0].userId;
const TOBI_USER = DEMO_PROFILES[1].userId;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const ACTIVE = 'mock';
/** A fixed clock for the notice tests: their rules carry their own dates, so the words are stable. */
const NOW = new Date('2027-01-10T09:00:00Z');
const later = (from, hours) => new Date(from.getTime() + hours * HOUR);
const ago = (minutes) => new Date(Date.now() - minutes * MINUTE);

async function setup(t) {
  const database = await useDatabase(t);
  await database.fresh();
  return database;
}

/** One rule row straight into the table; `createdAt` defaults to `startsAt`. */
async function insertRule(
  database,
  {
    scope = 'account',
    kind = 'individual',
    profileId = scope === 'account' && kind === 'individual' ? ADA : null,
    businessId = null,
    fee = 'tip',
    payer = 'tipme',
    startsAt = new Date('2027-01-01T00:00:00Z'),
    endsAt = null,
    createdAt = startsAt,
  } = {},
) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at,
       ends_at, reason, set_by, approved_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Test rule', NULL, NULL, $10)`,
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
      createdAt,
    ],
  );
  return id;
}

const run = (database, now = NOW) =>
  runFeeWaiverNotices(database.db, { activeProvider: ACTIVE, now });

/** The fee waiver notifications, oldest first. */
const notices = async (database) =>
  (
    await database.pool.query(
      `SELECT user_id, kind, title, body, business_id FROM notifications
        WHERE kind LIKE 'fee_waiver_%' ORDER BY created_at, kind`,
    )
  ).rows;

const issuesOf = async (database, kind) =>
  (
    await database.pool.query(
      `SELECT dedupe_key, kind, severity, status, summary, resolved_by, subject
         FROM issues WHERE kind = $1 ORDER BY opened_at, dedupe_key`,
      [kind],
    )
  ).rows;

/** A payments-reserve reading: `low` true, false or null (unknown). */
async function paymentReading(database, { low, readAt }) {
  const id = randomUUID();
  const available = low === null ? null : low ? 1000 : 9_000_000;
  await database.pool.query(
    `INSERT INTO payment_reserve_readings (id, provider, currency, available_minor, threshold_minor,
       low, read_at)
     VALUES ($1, $2, 'NGN', $3, 5000000, $4, $5)`,
    [id, ACTIVE, available, low, readAt],
  );
  return id;
}

/** A You collect reserve reading at `level` ('ok' or 'critical'). */
async function collectReading(database, { level, readAt }) {
  const id = randomUUID();
  const own = level === 'critical' ? 100_000 : 9_000_000;
  await database.pool.query(
    `INSERT INTO collect_reserve_readings (id, provider, currency, available_minor, held_minor,
       own_minor, warning_minor, critical_minor, level, read_at)
     VALUES ($1, $2, 'NGN', $3, 0, $3, 1000000, 500000, $4, $5)`,
    [id, ACTIVE, own, level, readAt],
  );
  return id;
}

test('an account waiver starting sends its owner one notification, however often the job runs', async (t) => {
  const database = await setup(t);
  await insertRule(database, {
    endsAt: new Date(endOfLagosDayIso('2027-01-31')),
  });
  await insertRule(database, { profileId: TOBI, fee: 'withdrawal' });
  const first = await run(database);
  assert.equal(first.started, 2);
  for (let i = 0; i < 3; i++) assert.equal((await run(database)).started, 0);
  const sent = await notices(database);
  assert.deepEqual(
    sent
      .map(({ user_id, kind, body }) => ({ user_id, kind, body }))
      .sort((a, b) => a.user_id.localeCompare(b.user_id)),
    [
      {
        user_id: TOBI_USER,
        kind: 'fee_waiver_started',
        body: 'TipMe is covering your withdrawal fees',
      },
      {
        user_id: ADA_USER,
        kind: 'fee_waiver_started',
        // The last day it covers, in Lagos: it ends at 1 Feb 00:00 WAT.
        body: 'TipMe is covering the fee on your tips until 31 Jan',
      },
    ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
  );
  // Never the payment partner's name.
  for (const notice of sent)
    assert.doesNotMatch(`${notice.title} ${notice.body}`, /bachs|mock/i);
});

test('a waiver not started yet, or paid by the account, sends nothing', async (t) => {
  const database = await setup(t);
  await insertRule(database, { startsAt: later(NOW, 2) });
  await insertRule(database, { profileId: TOBI, payer: 'account' });
  assert.equal((await run(database)).started, 0);
  assert.equal((await notices(database)).length, 0);
  // Once it starts, it is told.
  assert.equal((await run(database, later(NOW, 3))).started, 1);
});

test("a business waiver notifies the business's owners", async (t) => {
  const database = await setup(t);
  const { businessId, locations } = await seedBusiness(database.db, {
    name: 'The Yellow Chilli',
  });
  await seedManager(database.db, { businessId, userId: TOBI_USER });
  const other = await seedBusiness(database.db, { name: 'Other' });
  await seedManager(database.db, {
    businessId: other.businessId,
    userId: TOBI_USER,
    locationId: other.locations[0].id,
  });
  assert.ok(locations.length > 0);
  await insertRule(database, {
    kind: 'business',
    businessId,
    fee: 'withdrawal',
  });
  // The other business's location manager is not one of its owners.
  await insertRule(database, {
    kind: 'business',
    businessId: other.businessId,
    fee: 'withdrawal',
  });
  assert.equal((await run(database)).started, 2);
  assert.equal((await run(database)).started, 0);
  const sent = await notices(database);
  const forFirst = sent.filter((n) => n.business_id === businessId);
  assert.deepEqual(
    forFirst.map((n) => n.user_id).sort(),
    [ADA_USER, TOBI_USER].sort(),
  );
  for (const notice of forFirst) {
    assert.equal(notice.kind, 'fee_waiver_started');
    assert.equal(notice.body, 'TipMe is covering your withdrawal fees');
    assert.match(notice.title, /The Yellow Chilli/);
  }
  assert.deepEqual(
    sent
      .filter((n) => n.business_id === other.businessId)
      .map((n) => n.user_id),
    [ADA_USER],
  );
});

test('an account waiver ending or replaced sends one ended notice', async (t) => {
  const database = await setup(t);
  // Ends on its own, on the 31st.
  const ending = await insertRule(database, {
    endsAt: new Date(endOfLagosDayIso('2027-01-31')),
  });
  // Replaced by "normal rules" (inherit) after it started.
  const replaced = await insertRule(database, {
    profileId: TOBI,
    fee: 'withdrawal',
  });
  assert.equal((await run(database)).started, 2);
  await insertRule(database, {
    profileId: TOBI,
    fee: 'withdrawal',
    payer: 'inherit',
    startsAt: later(NOW, 1),
  });
  const afterReplace = later(NOW, 2);
  assert.equal((await run(database, afterReplace)).ended, 1);
  assert.equal((await run(database, afterReplace)).ended, 0);
  const afterEnd = new Date('2027-02-01T08:00:00Z');
  assert.equal((await run(database, afterEnd)).ended, 1);
  for (let i = 0; i < 3; i++)
    assert.equal((await run(database, afterEnd)).ended, 0);
  const ended = (await notices(database)).filter(
    (n) => n.kind === 'fee_waiver_ended',
  );
  assert.deepEqual(
    ended.map((n) => n.user_id).sort(),
    [ADA_USER, TOBI_USER].sort(),
  );
  for (const notice of ended)
    assert.equal(
      notice.body,
      'TipMe’s fee cover has ended. Normal fees apply from now.',
    );
  const rows = (
    await database.pool.query(
      `SELECT rule_id, kind FROM fee_waiver_notices ORDER BY rule_id, kind`,
    )
  ).rows;
  assert.deepEqual(
    rows,
    [
      { rule_id: ending, kind: 'ended' },
      { rule_id: ending, kind: 'started' },
      { rule_id: replaced, kind: 'ended' },
      { rule_id: replaced, kind: 'started' },
    ].sort(
      (a, b) =>
        a.rule_id.localeCompare(b.rule_id) || a.kind.localeCompare(b.kind),
    ),
  );
});

test('a waiver renewed, or still covered kind-wide, is not told it ended', async (t) => {
  const database = await setup(t);
  await insertRule(database, {
    endsAt: new Date(endOfLagosDayIso('2027-01-31')),
  });
  await insertRule(database, { profileId: TOBI, fee: 'withdrawal' });
  assert.equal((await run(database)).started, 2);
  // Ada's waiver is renewed to the end of February: she is told the new end, not that it ended.
  await insertRule(database, {
    endsAt: new Date(endOfLagosDayIso('2027-02-28')),
    startsAt: later(NOW, 1),
  });
  // Tobi's own waiver ends while every individual's withdrawal fee is covered.
  await insertRule(database, {
    scope: 'kind',
    fee: 'withdrawal',
    startsAt: later(NOW, 1),
  });
  await insertRule(database, {
    profileId: TOBI,
    fee: 'withdrawal',
    payer: 'inherit',
    startsAt: later(NOW, 1),
  });
  const result = await run(database, later(NOW, 2));
  assert.equal(result.started, 1);
  assert.equal(result.ended, 0);
  const sent = await notices(database);
  assert.equal(sent.filter((n) => n.kind === 'fee_waiver_ended').length, 0);
  assert.deepEqual(
    sent.filter((n) => n.user_id === ADA_USER).map((n) => n.body),
    [
      'TipMe is covering the fee on your tips until 31 Jan',
      'TipMe is covering the fee on your tips until 28 Feb',
    ],
  );
});

test('a kind waiver sends no notifications', async (t) => {
  const database = await setup(t);
  await insertRule(database, { scope: 'kind', fee: 'tip' });
  await insertRule(database, { scope: 'kind', fee: 'withdrawal' });
  await insertRule(database, {
    scope: 'kind',
    kind: 'business',
    fee: 'withdrawal',
    startsAt: later(NOW, -1),
  });
  const result = await run(database);
  assert.equal(result.started, 0);
  assert.equal(result.ended, 0);
  assert.equal((await notices(database)).length, 0);
  assert.equal(await database.count('fee_waiver_notices'), 0);
});

test('staff get one fee_waiver_ending issue the day before a waiver ends', async (t) => {
  const database = await setup(t);
  const endsAt = later(NOW, 30);
  const account = await insertRule(database, { endsAt });
  const kindWide = await insertRule(database, { scope: 'kind', endsAt });
  // An end with no waiver (R19) is not a waiver ending.
  await insertRule(database, {
    scope: 'kind',
    fee: 'withdrawal',
    payer: 'account',
    endsAt,
  });
  assert.equal((await run(database)).endingSoon, 0);
  const dayBefore = later(NOW, 7);
  assert.equal((await run(database, dayBefore)).endingSoon, 2);
  for (let i = 0; i < 3; i++)
    assert.equal((await run(database, later(dayBefore, i))).endingSoon, 0);
  const opened = await issuesOf(database, 'fee_waiver_ending');
  assert.deepEqual(
    opened.map((i) => i.dedupe_key).sort(),
    [`fee_waiver_ending.${account}`, `fee_waiver_ending.${kindWide}`].sort(),
  );
  for (const issue of opened) {
    assert.equal(issue.severity, 'info');
    assert.equal(issue.status, 'open');
    assert.match(issue.summary, /^A fee waiver ends within a day/);
  }
  assert.equal(
    opened.find((i) => i.dedupe_key.endsWith(account)).subject.profileId,
    ADA,
  );
  // Once it has ended, the issue closes itself.
  await run(database, later(NOW, 31));
  for (const issue of await issuesOf(database, 'fee_waiver_ending')) {
    assert.equal(issue.status, 'resolved');
    assert.equal(issue.resolved_by, 'system');
  }
});

const pausedRun = (database) =>
  runFeeWaiverNotices(database.db, {
    activeProvider: ACTIVE,
    now: new Date(),
  });

/** A kind-wide TipMe-pays tip waiver in force now. */
const tipWaiverNow = (database) =>
  insertRule(database, {
    scope: 'kind',
    startsAt: ago(24 * 60),
  });

test('paused with a tip waiver in force opens one issue per spell, resolves when the balance recovers, and a new spell opens a new one', async (t) => {
  const database = await setup(t);
  await tipWaiverNow(database);
  await paymentReading(database, { low: false, readAt: ago(60) });
  assert.equal((await pausedRun(database)).paused, 'none');
  const first = await paymentReading(database, { low: true, readAt: ago(50) });
  assert.equal((await pausedRun(database)).paused, 'opened');
  await paymentReading(database, { low: true, readAt: ago(40) });
  assert.equal((await pausedRun(database)).paused, 'open');
  assert.equal((await pausedRun(database)).paused, 'open');
  let opened = await issuesOf(database, 'fee_waivers_paused');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].dedupe_key, `fee_waivers_paused.${first}`);
  assert.equal(opened[0].severity, 'money');
  assert.match(
    opened[0].summary,
    /^Fee waivers paused: TipMe's balance is low/,
  );
  await paymentReading(database, { low: false, readAt: ago(30) });
  assert.equal((await pausedRun(database)).paused, 'resolved');
  assert.equal((await pausedRun(database)).paused, 'none');
  opened = await issuesOf(database, 'fee_waivers_paused');
  assert.equal(opened[0].status, 'resolved');
  assert.equal(opened[0].resolved_by, 'system');
  const second = await paymentReading(database, { low: true, readAt: ago(20) });
  assert.equal((await pausedRun(database)).paused, 'opened');
  opened = await issuesOf(database, 'fee_waivers_paused');
  assert.deepEqual(
    opened.map((i) => [i.dedupe_key, i.status]),
    [
      [`fee_waivers_paused.${first}`, 'resolved'],
      [`fee_waivers_paused.${second}`, 'open'],
    ],
  );
});

test('an unknown reading between two low ones keeps one spell', async (t) => {
  const database = await setup(t);
  await tipWaiverNow(database);
  const first = await paymentReading(database, { low: true, readAt: ago(50) });
  assert.equal((await pausedRun(database)).paused, 'opened');
  await paymentReading(database, { low: null, readAt: ago(40) });
  assert.equal((await pausedRun(database)).paused, 'open');
  await paymentReading(database, { low: true, readAt: ago(30) });
  assert.equal((await pausedRun(database)).paused, 'open');
  const opened = await issuesOf(database, 'fee_waivers_paused');
  assert.deepEqual(
    opened.map((i) => [i.dedupe_key, i.status]),
    [[`fee_waivers_paused.${first}`, 'open']],
  );
});

test('a spell where the payments reading goes low and then the collect reading goes critical stays one issue', async (t) => {
  const database = await setup(t);
  await tipWaiverNow(database);
  await collectReading(database, { level: 'ok', readAt: ago(70) });
  const first = await paymentReading(database, { low: true, readAt: ago(50) });
  assert.equal((await pausedRun(database)).paused, 'opened');
  await collectReading(database, { level: 'critical', readAt: ago(40) });
  // The payments reading recovers, but the collect one still pauses: the same spell.
  await paymentReading(database, { low: false, readAt: ago(30) });
  assert.equal((await pausedRun(database)).paused, 'open');
  const opened = await issuesOf(database, 'fee_waivers_paused');
  assert.deepEqual(
    opened.map((i) => [i.dedupe_key, i.status]),
    [[`fee_waivers_paused.${first}`, 'open']],
  );
  await collectReading(database, { level: 'ok', readAt: ago(20) });
  assert.equal((await pausedRun(database)).paused, 'resolved');
});

test('paused with no tip waiver in force opens nothing', async (t) => {
  const database = await setup(t);
  // Withdrawal waivers are not paused, and a tip rule the account pays is not a waiver.
  await insertRule(database, {
    scope: 'kind',
    fee: 'withdrawal',
    startsAt: ago(24 * 60),
  });
  await insertRule(database, {
    payer: 'account',
    startsAt: ago(24 * 60),
  });
  // A tip waiver that has ended is not in force.
  await insertRule(database, {
    profileId: TOBI,
    startsAt: ago(48 * 60),
    endsAt: ago(24 * 60),
  });
  await paymentReading(database, { low: true, readAt: ago(10) });
  assert.equal((await pausedRun(database)).paused, 'none');
  assert.equal((await issuesOf(database, 'fee_waivers_paused')).length, 0);
});
