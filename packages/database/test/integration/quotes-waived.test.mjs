import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  balanceOf,
  createPaymentIntent,
  createQuote,
  feeWaiversPaused,
  grantFeeFreeTips,
  grantOwner,
  markAttemptInitiated,
  recordProviderEvent,
  setAccountFee,
} from '../../dist/index.js';
import { seedBusiness, seedMember } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Fee waivers, plan Task 4 (spec 2026-11-23 §4, §5; W6, W7): a tip quote under a TipMe-pays tip
// rule, fee-free credits beside it, and the pause while TipMe's partner balance reads low.

const MINUTE = 60_000;
const ago = (minutes) => new Date(Date.now() - minutes * MINUTE);
const ACTIVE = 'mock';

/** One rule row straight into the table (ids have no default); `createdAt` defaults to `startsAt`. */
async function insertRule(
  database,
  {
    scope = 'kind',
    kind = 'individual',
    profileId = null,
    fee = 'tip',
    payer = 'tipme',
    startsAt = ago(24 * 60),
    endsAt = null,
    createdAt = startsAt,
  } = {},
) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at,
       ends_at, reason, set_by, approved_by, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, 'Test rule', NULL, NULL, $9)`,
    [id, scope, kind, profileId, fee, payer, startsAt, endsAt, createdAt],
  );
  return id;
}

/** A payments-reserve reading: `low` true, false or null (unknown). */
async function paymentReading(
  database,
  { provider = ACTIVE, low, readAt = ago(1) },
) {
  const id = randomUUID();
  const available = low === null ? null : low ? 1000 : 9_000_000;
  await database.pool.query(
    `INSERT INTO payment_reserve_readings (id, provider, currency, available_minor, threshold_minor,
       low, read_at)
     VALUES ($1, $2, 'NGN', $3, 5000000, $4, $5)`,
    [id, provider, available, low, readAt],
  );
  return id;
}

/** A You collect reserve reading at `level` ('ok', 'warning', 'critical', 'breach' or null). */
async function collectReading(
  database,
  { provider = ACTIVE, level, readAt = ago(1) },
) {
  const id = randomUUID();
  // available, held, own; warning 1,000,000 and critical 500,000.
  const amounts = {
    ok: [9_000_000, 0, 9_000_000],
    warning: [700_000, 0, 700_000],
    critical: [100_000, 0, 100_000],
    breach: [100_000, 400_000, -300_000],
  }[level] ?? [null, 0, null];
  await database.pool.query(
    `INSERT INTO collect_reserve_readings (id, provider, currency, available_minor, held_minor,
       own_minor, warning_minor, critical_minor, level, read_at)
     VALUES ($1, $2, 'NGN', $3, $4, $5, 1000000, 500000, $6, $7)`,
    [id, provider, ...amounts, level ?? null, readAt],
  );
  return id;
}

async function setup(t) {
  const database = await useDatabase(t);
  await database.fresh();
  return database;
}

const quoteFor = (database, handle, extra = {}) =>
  createQuote(database.db, {
    handle,
    tipMinor: 500000n,
    currency: 'NGN',
    youCollectOn: false,
    activeProvider: ACTIVE,
    ...extra,
  });

const storedQuote = async (database, quoteId) =>
  (
    await database.pool.query(
      `SELECT platform_fee_minor::text, provider_fee_minor::text, recipient_net_minor::text,
              waived_platform_fee_minor::text, fee_policy_version, fee_waiver_id, collection_mode
         FROM tip_quotes WHERE id = $1`,
      [quoteId],
    )
  ).rows[0];

/** Pays a quote as the mock partner's webhook would; the partner keeps `providerFeeMinor`. */
async function pay(database, quote, { providerFeeMinor = 7500n } = {}) {
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
  const outcome = await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: quote.breakdown.payerTotalMinor,
    currency: 'NGN',
    providerFeeMinor,
    signatureVerified: true,
    payload: {},
  });
  return { tipId: intent.tipId, outcome: outcome.outcome };
}

const creditsOf = async (database, profileId) =>
  (
    await database.pool.query(
      'SELECT remaining FROM fee_free_credits WHERE profile_id = $1',
      [profileId],
    )
  ).rows[0]?.remaining ?? 0;

const ledgerOfTip = async (database, tipId) =>
  (
    await database.pool.query(
      `SELECT a.code, e.side, e.amount_minor::text AS amount
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.tip_id = $1
        ORDER BY a.code, e.side`,
      [tipId],
    )
  ).rows;

/** The quote is priced normally on a Free page: TipMe keeps 5% of ₦5,000, processing included. */
function assertNormal(quote, row) {
  assert.equal(quote.feeFree, false);
  assert.equal(quote.feeWaiverId, null);
  assert.equal(
    quote.breakdown.platformFeeMinor + quote.breakdown.providerFeeMinor,
    25000n,
  );
  assert.equal(quote.breakdown.recipientNetMinor, 475000n);
  assert.equal(row.fee_waiver_id, null);
  assert.equal(row.waived_platform_fee_minor, '0');
  assert.equal(row.fee_policy_version, 'v3-free-500bps');
}

/** The quote is waived under `ruleId`: ₦0 fee, the whole tip to the recipient. */
function assertWaived(
  quote,
  row,
  ruleId,
  { waived = '25000', base = 'v3-free-500bps' } = {},
) {
  assert.equal(quote.feeFree, true);
  assert.equal(quote.feeWaiverId, ruleId);
  assert.equal(quote.breakdown.platformFeeMinor, 0n);
  assert.equal(quote.breakdown.providerFeeMinor, 0n);
  assert.equal(quote.breakdown.recipientNetMinor, 500000n);
  assert.equal(quote.feePolicyVersion, `${base}-waived-${ruleId}`);
  assert.equal(row.fee_waiver_id, ruleId);
  assert.equal(row.waived_platform_fee_minor, waived);
  assert.equal(row.fee_policy_version, `${base}-waived-${ruleId}`);
}

test('a kind waiver prices a ₦0 fee and records the rule', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  const quote = await quoteFor(database, 'ada');
  const row = await storedQuote(database, quote.quoteId);
  assert.equal(row.platform_fee_minor, '0');
  assert.equal(row.provider_fee_minor, '0');
  assert.equal(row.recipient_net_minor, '500000');
  // What the plan rate would have taken: 5% of ₦5,000.
  assertWaived(quote, row, ruleId);
});

test('a waived quote at a 0% custom rate still says fee-free, with nothing waived', async (t) => {
  const database = await setup(t);
  const { userId: staff } = await grantOwner(database.db, {
    phone: '+2348000009999',
  });
  await setAccountFee(database.db, {
    profileId: ADA,
    staffUserId: staff,
    feeBps: 0,
    reason: 'Charity partner',
  });
  const ruleId = await insertRule(database);
  const quote = await quoteFor(database, 'ada');
  assertWaived(quote, await storedQuote(database, quote.quoteId), ruleId, {
    waived: '0',
    base: 'v3-free-500bps-custom-0',
  });
});

test('an account waiver beats a custom rate, and waived records the custom share', async (t) => {
  const database = await setup(t);
  const { userId: staff } = await grantOwner(database.db, {
    phone: '+2348000009999',
  });
  await setAccountFee(database.db, {
    profileId: ADA,
    staffUserId: staff,
    feeBps: 200,
    reason: 'Launch partner',
  });
  await grantFeeFreeTips(database.db, {
    profileId: ADA,
    staffUserId: staff,
    count: 1,
    reason: 'Apology for downtime',
  });
  const ruleId = await insertRule(database, {
    scope: 'account',
    profileId: ADA,
  });
  const quote = await quoteFor(database, 'ada');
  // 2% of ₦5,000 is what the custom rate would have taken.
  assertWaived(quote, await storedQuote(database, quote.quoteId), ruleId, {
    waived: '10000',
    base: 'v3-free-500bps-custom-200',
  });
});

test('an account opted out of a kind waiver is priced normally', async (t) => {
  const database = await setup(t);
  const kindRule = await insertRule(database);
  await insertRule(database, {
    scope: 'account',
    profileId: ADA,
    payer: 'account',
  });
  const ada = await quoteFor(database, 'ada');
  assertNormal(ada, await storedQuote(database, ada.quoteId));
  // Everyone else of the kind is still waived.
  const tobi = await quoteFor(database, 'tobi');
  assertWaived(tobi, await storedQuote(database, tobi.quoteId), kindRule);
});

test('a waived tip never uses up a fee-free credit', async (t) => {
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
  const ruleId = await insertRule(database);
  const waived = await quoteFor(database, 'ada');
  assertWaived(waived, await storedQuote(database, waived.quoteId), ruleId);

  // The waiver ends (a later row of its key); the waived quote is still open.
  await insertRule(database, { payer: 'account', startsAt: ago(0.001) });
  const credited = await quoteFor(database, 'ada');
  const creditedRow = await storedQuote(database, credited.quoteId);
  // The open waived quote reserves nothing, so this one still gets the credit.
  assert.equal(credited.feeFree, true);
  assert.equal(credited.feeWaiverId, null);
  assert.equal(creditedRow.fee_waiver_id, null);
  assert.equal(creditedRow.waived_platform_fee_minor, '25000');
  assert.equal(creditedRow.fee_policy_version, 'v3-free-500bps-fee-free');

  assert.equal((await pay(database, waived)).outcome, 'applied');
  assert.equal(await creditsOf(database, ADA), 1);
  await pay(database, credited);
  assert.equal(await creditsOf(database, ADA), 0);
});

test('a waiver ending between quote and payment: the quote is honoured', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  const before = (await balanceOf(database.db, ADA)).availableMinor;
  const quote = await quoteFor(database, 'ada');
  await insertRule(database, { payer: 'account', startsAt: ago(0.001) });
  const { tipId } = await pay(database, quote, { providerFeeMinor: 7500n });
  assert.equal(
    (await balanceOf(database.db, ADA)).availableMinor - before,
    500000n,
  );
  // TipMe's fee and its processing estimate are 0; the partner's real fee is TipMe's cost.
  assert.deepEqual(await ledgerOfTip(database, tipId), [
    { code: 'provider_clearing', side: 'debit', amount: '492500' },
    { code: 'provider_fee_expense', side: 'debit', amount: '7500' },
    { code: 'recipient_payable', side: 'credit', amount: '500000' },
  ]);
  const row = await storedQuote(database, quote.quoteId);
  assert.equal(row.fee_waiver_id, ruleId);
});

test('a waived quote stays waived through payment after the pause starts', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  const before = (await balanceOf(database.db, ADA)).availableMinor;
  const quote = await quoteFor(database, 'ada');
  await paymentReading(database, { low: true, readAt: new Date() });
  assert.equal(
    (await feeWaiversPaused(database.db, { activeProvider: ACTIVE })).paused,
    true,
  );
  const { outcome } = await pay(database, quote);
  assert.equal(outcome, 'applied');
  assert.equal(
    (await balanceOf(database.db, ADA)).availableMinor - before,
    500000n,
  );
  assert.equal(
    (await storedQuote(database, quote.quoteId)).fee_waiver_id,
    ruleId,
  );
});

/** A direct page (Ada) and a You collect page (Tobi). */
async function directAndCollect(database) {
  await database.pool.query(
    `UPDATE profiles SET collection_mode = 'collect', collect_verified_at = now() WHERE id = $1`,
    [TOBI],
  );
  const direct = await quoteFor(database, 'ada');
  const collect = await quoteFor(database, 'tobi');
  const collectRow = await storedQuote(database, collect.quoteId);
  assert.equal(collectRow.collection_mode, 'collect');
  return [
    [direct, await storedQuote(database, direct.quoteId)],
    [collect, collectRow],
  ];
}

test('while the payments reserve reads low, new quotes ignore tip waivers', async (t) => {
  const database = await setup(t);
  await insertRule(database);
  const low = await paymentReading(database, { low: true });
  assert.deepEqual(
    await feeWaiversPaused(database.db, { activeProvider: ACTIVE }),
    {
      paused: true,
      signals: ['payment_reserve_low'],
      spellStartReadingId: low,
    },
  );
  for (const [quote, row] of await directAndCollect(database))
    assertNormal(quote, row);
});

test('while the You collect reserve reads critical or breach, new quotes ignore tip waivers', async (t) => {
  const database = await setup(t);
  await insertRule(database);
  for (const level of ['critical', 'breach']) {
    await database.pool.query('DELETE FROM collect_reserve_readings');
    const reading = await collectReading(database, { level });
    assert.deepEqual(
      await feeWaiversPaused(database.db, { activeProvider: ACTIVE }),
      {
        paused: true,
        signals: ['collect_reserve_critical'],
        spellStartReadingId: reading,
      },
      level,
    );
    for (const [quote, row] of await directAndCollect(database))
      assertNormal(quote, row);
  }
});

test('a later reading that is not low or critical lifts the pause', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  await paymentReading(database, { low: true, readAt: ago(4) });
  await paymentReading(database, { low: false, readAt: ago(3) });
  await collectReading(database, { level: 'breach', readAt: ago(4) });
  // A warning is not critical: it does not pause.
  await collectReading(database, { level: 'warning', readAt: ago(3) });
  assert.deepEqual(
    await feeWaiversPaused(database.db, { activeProvider: ACTIVE }),
    { paused: false, signals: [], spellStartReadingId: null },
  );
  for (const [quote, row] of await directAndCollect(database))
    assertWaived(quote, row, ruleId);
});

test('the pause reads the latest known reading, and its spell spans both signals', async (t) => {
  const database = await setup(t);
  await insertRule(database);
  const paused = () =>
    feeWaiversPaused(database.db, { activeProvider: ACTIVE });

  // An earlier spell, then a gap with neither signal set.
  await paymentReading(database, { low: true, readAt: ago(60) });
  await paymentReading(database, { low: false, readAt: ago(50) });
  // A new spell: an unknown reading in the middle neither ends it nor starts another (R11).
  const first = await paymentReading(database, { low: true, readAt: ago(40) });
  await paymentReading(database, { low: null, readAt: ago(35) });
  await paymentReading(database, { low: true, readAt: ago(30) });
  await paymentReading(database, { low: null, readAt: ago(25) });
  assert.deepEqual(await paused(), {
    paused: true,
    signals: ['payment_reserve_low'],
    spellStartReadingId: first,
  });
  const duringSpell = await quoteFor(database, 'ada');
  assertNormal(duringSpell, await storedQuote(database, duringSpell.quoteId));

  // The collect reserve goes critical before the payments reserve recovers: still one spell.
  await collectReading(database, { level: 'critical', readAt: ago(20) });
  await paymentReading(database, { low: false, readAt: ago(15) });
  assert.deepEqual(await paused(), {
    paused: true,
    signals: ['collect_reserve_critical'],
    spellStartReadingId: first,
  });
  // Both clear, then the payments reserve reads low again: a new spell.
  await collectReading(database, { level: 'ok', readAt: ago(10) });
  const again = await paymentReading(database, { low: true, readAt: ago(5) });
  assert.deepEqual(await paused(), {
    paused: true,
    signals: ['payment_reserve_low'],
    spellStartReadingId: again,
  });
});

test('no reading or an unknown reading does not pause', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  const none = { paused: false, signals: [], spellStartReadingId: null };
  assert.deepEqual(
    await feeWaiversPaused(database.db, { activeProvider: ACTIVE }),
    none,
  );
  await paymentReading(database, { low: null });
  await collectReading(database, { level: null });
  assert.deepEqual(
    await feeWaiversPaused(database.db, { activeProvider: ACTIVE }),
    none,
  );
  const quote = await quoteFor(database, 'ada');
  assertWaived(quote, await storedQuote(database, quote.quoteId), ruleId);
});

test('a reading for another adapter does not pause', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  // A withdraw-only adapter reads low; the active one (mock) has no reading.
  await paymentReading(database, { provider: 'bachs-sandbox', low: true });
  await collectReading(database, {
    provider: 'bachs-sandbox',
    level: 'breach',
  });
  assert.equal(
    (await feeWaiversPaused(database.db, { activeProvider: ACTIVE })).paused,
    false,
  );
  const quote = await quoteFor(database, 'ada');
  assertWaived(quote, await storedQuote(database, quote.quoteId), ruleId);
});

test('a missing or empty active provider reads as no reading, never paused (R7)', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  await paymentReading(database, { low: true });
  for (const activeProvider of ['', undefined])
    assert.deepEqual(await feeWaiversPaused(database.db, { activeProvider }), {
      paused: false,
      signals: [],
      spellStartReadingId: null,
    });
  // A caller that passes no provider (the .mjs tests) still gets the waiver.
  const quote = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 500000n,
    currency: 'NGN',
    youCollectOn: false,
  });
  assertWaived(quote, await storedQuote(database, quote.quoteId), ruleId);
});

test('a business staff member follows individual tip rules', async (t) => {
  const database = await setup(t);
  const { locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI,
  });
  const ruleId = await insertRule(database, { kind: 'individual' });
  const quote = await quoteFor(database, 'tobi', {
    businessMemberId: memberId,
    sharesOn: true,
  });
  assertWaived(quote, await storedQuote(database, quote.quoteId), ruleId);
});

test('a waived You collect tip: the whole tip is held for the recipient and TipMe pays processing', async (t) => {
  const database = await setup(t);
  const ruleId = await insertRule(database);
  await database.pool.query(
    `UPDATE profiles SET collection_mode = 'collect', collect_verified_at = now() WHERE id = $1`,
    [TOBI],
  );
  const quote = await quoteFor(database, 'tobi');
  const row = await storedQuote(database, quote.quoteId);
  assert.equal(row.collection_mode, 'collect');
  assertWaived(quote, row, ruleId);
  const { tipId, outcome } = await pay(database, quote, {
    providerFeeMinor: 7500n,
  });
  assert.equal(outcome, 'applied');
  const lines = await ledgerOfTip(database, tipId);
  // TipMe's own money (platform_clearing) pays the partner's real fee; no fee revenue is booked.
  assert.deepEqual(lines, [
    { code: 'held_for_recipients', side: 'debit', amount: '500000' },
    { code: 'platform_clearing', side: 'credit', amount: '7500' },
    { code: 'provider_fee_expense', side: 'debit', amount: '7500' },
    { code: 'recipient_payable', side: 'credit', amount: '500000' },
  ]);
  const sum = (side) =>
    lines
      .filter((l) => l.side === side)
      .reduce((a, l) => a + BigInt(l.amount), 0n);
  assert.equal(sum('debit'), sum('credit'));
});

/** Fails the test instead of hanging it when the pause read never returns. */
const within = (promise, ms = 10_000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms).unref(),
    ),
  ]);

test('a signalling reading stamped before 2000 (a clock fault) still gives a start, in bounded time', async (t) => {
  const database = await setup(t);
  await paymentReading(database, {
    low: false,
    readAt: new Date('1999-12-30T12:00:00Z'),
  });
  const low = await paymentReading(database, {
    low: true,
    readAt: new Date('1999-12-31T12:00:00Z'),
  });
  assert.deepEqual(
    await within(feeWaiversPaused(database.db, { activeProvider: ACTIVE })),
    {
      paused: true,
      signals: ['payment_reserve_low'],
      spellStartReadingId: low,
    },
  );
  // With no clear reading before it either.
  await database.pool.query(
    `DELETE FROM payment_reserve_readings WHERE low = false`,
  );
  assert.equal(
    (await within(feeWaiversPaused(database.db, { activeProvider: ACTIVE })))
      .spellStartReadingId,
    low,
  );
});

/** Readings every `step` from `fromDays` to `toDays` ago (in SQL: thousands of rows at once). */
async function manyReadings(
  database,
  { table, fromDays, toDays, step, signal },
) {
  const values =
    table === 'payment_reserve_readings'
      ? signal
        ? `1000, 5000000, true`
        : `9000000, 5000000, false`
      : signal
        ? `100000, 0, 100000, 1000000, 500000, 'critical'`
        : `9000000, 0, 9000000, 1000000, 500000, 'ok'`;
  const columns =
    table === 'payment_reserve_readings'
      ? 'available_minor, threshold_minor, low'
      : 'available_minor, held_minor, own_minor, warning_minor, critical_minor, level';
  await database.pool.query(
    `INSERT INTO ${table} (id, provider, currency, ${columns}, read_at)
     SELECT gen_random_uuid(), $1, 'NGN', ${values}, at
       FROM generate_series(now() - $2::numeric * interval '1 day', now() - $3::numeric * interval '1 day',
                            $4::interval) AS at`,
    [ACTIVE, fromDays, toDays, step],
  );
}

const firstSignal = async (database, table, signal, afterSql = 'TRUE') =>
  (
    await database.pool.query(
      `SELECT id FROM ${table} WHERE ${signal} AND ${afterSql} ORDER BY read_at, id LIMIT 1`,
    )
  ).rows[0].id;

test('a long spell handed between the tables gives its first reading', async (t) => {
  const database = await setup(t);
  // The collect reserve is critical from 130 to 110 days ago; the payments reserve, clear 121 days
  // ago, reads low every 15 minutes from 120 days ago until now. One spell, begun 130 days ago.
  await manyReadings(database, {
    table: 'collect_reserve_readings',
    fromDays: 131,
    toDays: 131,
    step: '1 hour',
    signal: false,
  });
  await manyReadings(database, {
    table: 'collect_reserve_readings',
    fromDays: 130,
    toDays: 110,
    step: '1 hour',
    signal: true,
  });
  await manyReadings(database, {
    table: 'collect_reserve_readings',
    fromDays: 105,
    toDays: 105,
    step: '1 hour',
    signal: false,
  });
  await manyReadings(database, {
    table: 'payment_reserve_readings',
    fromDays: 121,
    toDays: 121,
    step: '1 hour',
    signal: false,
  });
  await manyReadings(database, {
    table: 'payment_reserve_readings',
    fromDays: 120,
    toDays: 0.001,
    step: '15 minutes',
    signal: true,
  });
  const expected = await firstSignal(
    database,
    'collect_reserve_readings',
    `level = 'critical'`,
  );
  assert.deepEqual(
    await within(feeWaiversPaused(database.db, { activeProvider: ACTIVE })),
    {
      paused: true,
      signals: ['payment_reserve_low'],
      spellStartReadingId: expected,
    },
  );
});

test('a spell longer than the look-back reports its first reading inside it', async (t) => {
  const database = await setup(t);
  await manyReadings(database, {
    table: 'payment_reserve_readings',
    fromDays: 501,
    toDays: 501,
    step: '1 hour',
    signal: false,
  });
  await manyReadings(database, {
    table: 'payment_reserve_readings',
    fromDays: 500,
    toDays: 0.001,
    // Not a divisor of 400 days, so no reading sits exactly on the look-back's edge.
    step: '7 hours',
    signal: true,
  });
  const expected = await firstSignal(
    database,
    'payment_reserve_readings',
    'low',
    `read_at > (SELECT max(read_at) FROM payment_reserve_readings) - interval '400 days'`,
  );
  assert.equal(
    (await within(feeWaiversPaused(database.db, { activeProvider: ACTIVE })))
      .spellStartReadingId,
    expected,
  );
});
