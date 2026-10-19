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
  const { cookie } = await signIn(stack.api, '+2348000000002');
  const summary = (await (await get('/v1/me/dashboard', cookie)).json()).data;
  assert.equal(summary.availableMinor, '187000');
  assert.equal(summary.today, '187000');
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
  const ada = await signIn(stack.api, '+2348000000001');
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
  const { cookie } = await signIn(stack.api, '+2348000000002');
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
  const ok = await withdraw('100000');
  assert.equal(ok.status, 201);
  const { payoutId } = (await ok.json()).data;
  const after = (await (await get('/v1/me/dashboard', cookie)).json()).data
    .availableMinor;
  assert.equal(BigInt(after), BigInt(before) - 100000n);
  const { reconcilePayouts } =
    await import('../../packages/database/dist/index.js');
  const { createMockProvider } =
    await import('../../packages/payments/dist/index.js');
  const { Redis } = await import('./helpers.mjs');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  try {
    await reconcilePayouts({
      db: database.db,
      provider: createMockProvider({ redis, prefix: stack.prefix }),
      now: new Date(),
      minAgeMs: 0,
    });
  } finally {
    await redis.quit();
  }
  const activity = (await (await get('/v1/me/activity', cookie)).json()).data;
  assert.equal(activity.find((row) => row.id === payoutId).state, 'sent');
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
  const tobi = await signIn(stack.api, '+2348000000002');
  const list = (await (await get('/v1/me/reports', tobi.cookie)).json()).data;
  assert.equal(list[0].week, week);
  const report = (
    await (await get(`/v1/me/reports/${week}`, tobi.cookie)).json()
  ).data;
  assert.equal(report.topSupporterLabel, 'Ada M.');
  assert.ok(Number(report.totalNetMinor) > 0);
  const ada = await signIn(stack.api, '+2348000000001');
  assert.equal((await get(`/v1/me/reports/${week}`, ada.cookie)).status, 404);
});
