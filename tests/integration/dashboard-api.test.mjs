import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, signIn, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

// Sign-in codes are limited per phone, so each phone signs in once for the whole file.
const sessions = new Map();
const session = (phone) => {
  if (!sessions.has(phone)) sessions.set(phone, signIn(stack.api, phone));
  return sessions.get(phone);
};

const get = (path, cookie) =>
  fetch(`${stack.api}${path}`, { headers: cookie ? { cookie } : {} });

/** A visitor tips Tobi through the public checkout and the pretend provider says it succeeded. */
async function tipTobi(message) {
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'tobi',
        amountMinor: '400000',
        currency: 'NGN',
      }),
    })
  ).json();
  const intent = await (
    await fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        quoteId: quote.data.quoteId,
        message,
        payerDisplayLabel: 'Ada M.',
      }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
  return intent.data.tipId;
}

test('a recipient sees their balance, tips and a tip with its proof', async () => {
  const tipId = await tipTobi('Lovely coffee');
  const { cookie } = await session('+2348000000002');
  const summary = (await (await get('/v1/me/dashboard', cookie)).json()).data;
  assert.equal(summary.availableMinor, '380000');
  assert.equal(summary.today, '380000');
  assert.equal(summary.last7Days.length, 7);
  const tips = (await (await get('/v1/me/tips?status=paid', cookie)).json())
    .data;
  assert.equal(tips.items[0].tipId, tipId);
  assert.equal(tips.items[0].supporterLabel, 'Ada M.');
  const detail = (await (await get(`/v1/me/tips/${tipId}`, cookie)).json())
    .data;
  assert.equal(detail.message, 'Lovely coffee');
  assert.equal(detail.proof.verified, true);
  assert.match(detail.proof.referenceTail, /^[0-9a-f-]{6}$/);
  const activity = (await (await get('/v1/me/activity', cookie)).json()).data;
  assert.equal(activity[0].kind, 'tip');
});

test('another recipient can never see those tips', async () => {
  const tipId = await tipTobi('Not for Ada');
  const ada = await session('+2348000000001');
  const detail = await get(`/v1/me/tips/${tipId}`, ada.cookie);
  assert.equal(detail.status, 404);
  const list = (await (await get('/v1/me/tips', ada.cookie)).json()).data;
  assert.equal(
    list.items.some((item) => item.tipId === tipId),
    false,
  );
  assert.equal((await get('/v1/me/dashboard')).status, 401);
  assert.equal((await get('/v1/me/tips/not-a-uuid', ada.cookie)).status, 404);
});

test('a withdrawal needs a key, respects the balance and is confirmed by reconciliation', async () => {
  const { browserHeaders } = await import('./helpers.mjs');
  await tipTobi('For the withdrawal');
  // The pretend provider needs no bank, so a payout records one only if the recipient has saved one.
  const { setPayoutDestination, mailSealing, DEMO_PROFILES } =
    await import('../../packages/database/dist/index.js');
  await setPayoutDestination(database.db, {
    profileId: DEMO_PROFILES[1].id,
    provider: 'mock',
    destinationRef: 'dest_integration',
    bankCode: '058',
    bankName: 'GTBank',
    last4: '6789',
    status: 'usable',
    sealing: mailSealing(Buffer.alloc(32, 7)),
  });
  const { cookie } = await session('+2348000000002');
  const before = (await (await get('/v1/me/dashboard', cookie)).json()).data
    .availableMinor;
  const withdraw = (amountMinor, key = randomUUID()) =>
    fetch(`${stack.api}/v1/me/withdrawals`, {
      method: 'POST',
      headers: browserHeaders(cookie, key ? { 'idempotency-key': key } : {}),
      body: JSON.stringify({ amountMinor }),
    });
  assert.equal((await withdraw('100', null)).status, 400);
  const tooMuch = await withdraw((BigInt(before) + 1n).toString());
  assert.equal(tooMuch.status, 409);
  assert.equal((await tooMuch.json()).error.code, 'INSUFFICIENT_BALANCE');
  const quote = (await (await get('/v1/me/withdrawal-quote', cookie)).json())
    .data;
  assert.equal(quote.state, 'ready');
  assert.equal(quote.withdrawableMinor, before);
  // A person pays the partner's ₦50 from the amount on every withdrawal (owner, 25 Nov 2026).
  assert.equal(quote.feeMinor, '5000');
  assert.equal(quote.feePaidBy, 'user');
  const ok = await withdraw('200000');
  assert.equal(ok.status, 201);
  const { payoutId } = (await ok.json()).data;
  // The request reaches no provider: it queues the job the worker starts the payout from.
  const { rows: queued } = await database.pool.query(
    `SELECT count(*)::int AS n FROM outbox_events
      WHERE event_type = 'payouts.start' AND aggregate_id = $1`,
    [payoutId],
  );
  assert.equal(queued[0].n, 1);
  const { rows: payoutRows } = await database.pool.query(
    'SELECT provider, provider_reference FROM payouts WHERE id = $1',
    [payoutId],
  );
  assert.deepEqual(payoutRows, [
    { provider: 'mock', provider_reference: null },
  ]);
  const after = (await (await get('/v1/me/dashboard', cookie)).json()).data
    .availableMinor;
  assert.equal(BigInt(after), BigInt(before) - 200000n);
  assert.equal(
    (await (await get('/v1/me/activity', cookie)).json()).data.find(
      (row) => row.id === payoutId,
    ).state,
    'requested',
  );
  const { markPayoutInitiated, reconcilePayouts } =
    await import('../../packages/database/dist/index.js');
  const { createMockProvider } =
    await import('../../packages/payments/dist/index.js');
  const { Redis } = await import('./helpers.mjs');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  try {
    // Started by hand here, as the worker's payouts.start handler does (live-payments Task 6).
    const provider = createMockProvider({ redis, prefix: stack.prefix });
    const { providerReference } = await provider.initiatePayout({
      payoutId,
      idempotencyKey: `payout.${payoutId}`,
      amountMinor: 200000n,
      currency: 'NGN',
    });
    await markPayoutInitiated(database.db, {
      payoutId,
      provider: 'mock',
      providerReference,
    });
    await provider.settlePayout(providerReference);
    await reconcilePayouts({
      db: database.db,
      provider,
      now: new Date(),
      minAgeMs: 0,
    });
  } finally {
    await redis.quit();
  }
  const activity = (await (await get('/v1/me/activity', cookie)).json()).data;
  assert.equal(activity.find((row) => row.id === payoutId).state, 'sent');
});

test('withdrawals are listed on their own, with their bank, and only to their owner', async () => {
  const { cookie } = await session('+2348000000002');
  const list = await get('/v1/me/withdrawals', cookie);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  const { items, nextCursor } = (await list.json()).data;
  assert.equal(nextCursor, null);
  const row = items[0];
  assert.ok(row.payoutId);
  assert.ok(
    [
      'requested',
      'processing',
      'in_review',
      'sent',
      'failed',
      'reversed',
    ].includes(row.state),
  );
  assert.deepEqual(row.bank, { bankName: 'GTBank', last4: '6789' });
  assert.deepEqual(Object.keys(row.bank).sort(), ['bankName', 'last4']);
  assert.equal((await get('/v1/me/withdrawals')).status, 401);
  const ada = await session('+2348000000001');
  const adas = (await (await get('/v1/me/withdrawals', ada.cookie)).json()).data
    .items;
  assert.equal(
    adas.some((other) => other.payoutId === row.payoutId),
    false,
  );
  assert.equal((await get('/v1/me/withdrawals?limit=0', cookie)).status, 400);
  assert.equal((await get('/v1/me/withdrawals?status=x', cookie)).status, 400);
});

test('tip totals and the note filter', async () => {
  await tipTobi('Thanks');
  await tipTobi();
  const { cookie } = await session('+2348000000002');
  const totalsResponse = await get('/v1/me/tip-totals', cookie);
  assert.equal(totalsResponse.status, 200);
  assert.equal(
    totalsResponse.headers.get('cache-control'),
    'private, no-store',
  );
  const totals = (await totalsResponse.json()).data;
  const paid = (
    await (await get('/v1/me/tips?status=paid&limit=50', cookie)).json()
  ).data.items;
  assert.equal(totals.paidTipCount, paid.length);
  assert.equal(
    BigInt(totals.receivedNetMinor),
    paid.reduce((sum, tip) => sum + BigInt(tip.netMinor), 0n),
  );
  assert.equal((await get('/v1/me/tip-totals')).status, 401);
  const noted = (
    await (await get('/v1/me/tips?status=paid&note=with', cookie)).json()
  ).data.items;
  assert.ok(noted.length > 0 && noted.length < paid.length);
  assert.ok(noted.every((tip) => tip.hasMessage === true));
  assert.equal((await get('/v1/me/tips?note=yes', cookie)).status, 400);
});

test('a weekly report is made on demand (development), listed, and read in full only by its owner', async () => {
  const { isoWeekOf } = await import('../../packages/database/dist/index.js');
  await tipTobi('For the report');
  const week = isoWeekOf(new Date());
  const run = await fetch(`${stack.api}/v1/dev/jobs/weekly-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isoWeek: week }),
  });
  assert.equal(run.status, 200);
  assert.ok((await run.json()).data.created >= 1);
  const tobi = await session('+2348000000002');
  const list = (await (await get('/v1/me/reports', tobi.cookie)).json()).data;
  assert.equal(list[0].week, week);
  const report = (
    await (await get(`/v1/me/reports/${week}`, tobi.cookie)).json()
  ).data;
  assert.equal(report.topSupporterLabel, 'Ada M.');
  assert.ok(Number(report.totalNetMinor) > 0);
  const ada = await session('+2348000000001');
  assert.equal((await get(`/v1/me/reports/${week}`, ada.cookie)).status, 404);
});

test('quotes share the partner read in Redis briefly; a withdrawal clears it', async () => {
  const { browserHeaders, Redis } = await import('./helpers.mjs');
  const { DEMO_PROFILES } =
    await import('../../packages/database/dist/index.js');
  await tipTobi('For the cache');
  const { cookie } = await session('+2348000000002');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  try {
    const account = `pq1:${stack.prefix}:mock:${DEMO_PROFILES[1].id}`;
    const version = async () =>
      Number((await redis.get(`${account}:version`)) ?? 0);
    const entries = async () => redis.keys(`${account}:${await version()}:*`);
    const first = (await (await get('/v1/me/withdrawal-quote', cookie)).json())
      .data;
    assert.equal(first.state, 'ready');
    const stored = await entries();
    assert.equal(stored.filter((key) => key.includes(':base:')).length, 1);
    assert.equal(stored.filter((key) => key.includes(':fee:')).length, 1);
    for (const key of stored) {
      const ttl = await redis.ttl(key);
      assert.ok(ttl > 0 && ttl <= 30, `${key} expires within 30 s`);
    }
    // TipMe's ledger isn't cached: the stored entries hold the partner's answer only.
    for (const key of stored)
      assert.doesNotMatch(await redis.get(key), /ledger/i);
    // A hit leaves the entries alone: a re-read of the partner would write them again and
    // restart their expiry, so the remaining time only falls.
    const ttls = async () => Promise.all(stored.map((key) => redis.pttl(key)));
    const firstTtls = await ttls();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = (await (await get('/v1/me/withdrawal-quote', cookie)).json())
      .data;
    assert.deepEqual(again, first);
    assert.deepEqual((await entries()).sort(), stored.sort());
    const secondTtls = await ttls();
    secondTtls.forEach((ttl, i) =>
      assert.ok(ttl <= firstTtls[i] - 1000, `${stored[i]} was not rewritten`),
    );

    const before = await version();
    const ok = await fetch(`${stack.api}/v1/me/withdrawals`, {
      method: 'POST',
      headers: browserHeaders(cookie, { 'idempotency-key': randomUUID() }),
      body: JSON.stringify({ amountMinor: '200000' }),
    });
    assert.equal(ok.status, 201);
    assert.equal(await version(), before + 2, 'invalidated before and after');
    // A refused request clears it too.
    const refused = await fetch(`${stack.api}/v1/me/withdrawals`, {
      method: 'POST',
      headers: browserHeaders(cookie, { 'idempotency-key': randomUUID() }),
      body: JSON.stringify({ amountMinor: '999999999999' }),
    });
    assert.equal(refused.status, 409);
    assert.equal(await version(), before + 4);
    assert.deepEqual(await entries(), []);
    const after = (await (await get('/v1/me/withdrawal-quote', cookie)).json())
      .data;
    assert.equal(
      BigInt(after.ledgerMinor),
      BigInt(first.ledgerMinor) - 200000n,
    );
  } finally {
    await redis.quit();
  }
});

/*
 * Fee waivers (spec 2026-11-23 §7, W17): what the recipient reads. Ada's own page only (account
 * scope), and last in this file, so no earlier test's fees change. A waiver is ended as e2e ends
 * one: by inserting a later row that has already ended (W16), never by editing a row.
 */
async function tipAda() {
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'ada',
        amountMinor: '200000',
        currency: 'NGN',
      }),
    })
  ).json();
  const intent = await (
    await fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        quoteId: quote.data.quoteId,
        payerDisplayLabel: 'A supporter',
      }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
  return intent.data.tipId;
}

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

/** Ada's tip waiver ends now: a later row of the same key, already over (W2, W16). */
const endAdasTipWaiver = (profileId) =>
  q(
    `INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at,
       ends_at, reason, set_by, approved_by, created_at)
     SELECT gen_random_uuid(), 'account', 'individual', $1::uuid, NULL, 'tip', 'tipme',
            max(starts_at) + interval '1 millisecond', max(starts_at) + interval '2 milliseconds',
            'Test: the end date has passed', NULL, NULL, clock_timestamp()
       FROM fee_waivers
      WHERE scope = 'account' AND fee = 'tip' AND profile_id = $1::uuid`,
    [profileId],
  );

const lowReading = () =>
  q(
    `INSERT INTO payment_reserve_readings
       (id, provider, currency, available_minor, threshold_minor, low, read_at)
     VALUES (gen_random_uuid(), 'mock', 'NGN', 10000, 100000, true, now())`,
  );
const okReading = () =>
  q(
    `INSERT INTO payment_reserve_readings
       (id, provider, currency, available_minor, threshold_minor, low, read_at)
     VALUES (gen_random_uuid(), 'mock', 'NGN', 900000, 100000, false, now() + interval '1 second')`,
  );

test('the dashboard carries tipFeeWaiver while an account tip waiver is in force', async () => {
  const ops = await import('../../packages/database/dist/index.js');
  const { endOfLagosDayIso, lagosDateOf } =
    await import('../../packages/domain/dist/index.js');
  const [ada, tobi] = ops.DEMO_PROFILES;
  const { cookie } = await session('+2348000000001');
  const summary = async () =>
    (await (await get('/v1/me/dashboard', cookie)).json()).data;
  assert.equal((await summary()).tipFeeWaiver, null);

  const endsAt = endOfLagosDayIso(
    lagosDateOf(new Date(Date.now() + 40 * 86_400_000)),
  );
  await database.db.transaction((tx) =>
    ops.setFeeWaiver(tx, {
      scope: 'account',
      kind: 'individual',
      profileId: ada.id,
      fee: 'tip',
      payer: 'tipme',
      endsAt,
      staffUserId: tobi.userId,
      approvedBy: ada.userId,
      reason: 'Launch partner for the dashboard test',
      now: new Date(),
    }),
  );
  assert.deepEqual((await summary()).tipFeeWaiver, { endsAt });
  // Tobi's page has no waiver: only the account it was set for sees the line.
  const tobiSession = await session('+2348000000002');
  assert.equal(
    (await (await get('/v1/me/dashboard', tobiSession.cookie)).json()).data
      .tipFeeWaiver,
    null,
  );

  await endAdasTipWaiver(ada.id);
  assert.equal((await summary()).tipFeeWaiver, null);
});

test('the dashboard line hides while waivers are paused', async () => {
  const ops = await import('../../packages/database/dist/index.js');
  const [ada, tobi] = ops.DEMO_PROFILES;
  const { cookie } = await session('+2348000000001');
  const summary = async () =>
    (await (await get('/v1/me/dashboard', cookie)).json()).data;
  // No end date this time: the line is there with endsAt null.
  await database.db.transaction((tx) =>
    ops.setFeeWaiver(tx, {
      scope: 'account',
      kind: 'individual',
      profileId: ada.id,
      fee: 'tip',
      payer: 'tipme',
      staffUserId: tobi.userId,
      approvedBy: ada.userId,
      reason: 'Launch partner with no end date',
      now: new Date(),
    }),
  );
  try {
    assert.deepEqual((await summary()).tipFeeWaiver, { endsAt: null });
    // TipMe's balance at the active partner is low (W6): new tips are priced normally, so the line
    // that says TipMe covers them goes.
    await lowReading();
    assert.equal((await summary()).tipFeeWaiver, null);
    await okReading();
    assert.deepEqual((await summary()).tipFeeWaiver, { endsAt: null });
  } finally {
    await q(`DELETE FROM payment_reserve_readings`);
    await endAdasTipWaiver(ada.id);
  }
});

test('a waived tip’s detail says feeCoveredByTipMe', async () => {
  const ops = await import('../../packages/database/dist/index.js');
  const [ada, tobi] = ops.DEMO_PROFILES;
  const { cookie } = await session('+2348000000001');
  const detail = async (tipId) =>
    (await (await get(`/v1/me/tips/${tipId}`, cookie)).json()).data;

  const before = await detail(await tipAda());
  assert.equal(before.feeCoveredByTipMe, false);
  assert.notEqual(before.platformFeeMinor, '0');

  await database.db.transaction((tx) =>
    ops.setFeeWaiver(tx, {
      scope: 'account',
      kind: 'individual',
      profileId: ada.id,
      fee: 'tip',
      payer: 'tipme',
      staffUserId: tobi.userId,
      approvedBy: ada.userId,
      reason: 'Launch partner for the tip detail test',
      now: new Date(),
    }),
  );
  const waivedTip = await tipAda();
  const waived = await detail(waivedTip);
  assert.equal(waived.feeCoveredByTipMe, true);
  assert.equal(waived.platformFeeMinor, '0');
  assert.equal(waived.providerFeeMinor, '0');
  assert.equal(waived.netMinor, '200000');

  // The waiver ends; the tip it covered keeps saying so (the quote recorded it), a new one doesn't.
  await endAdasTipWaiver(ada.id);
  assert.equal((await detail(waivedTip)).feeCoveredByTipMe, true);
  const after = await detail(await tipAda());
  assert.equal(after.feeCoveredByTipMe, false);
  assert.notEqual(after.platformFeeMinor, '0');
});
