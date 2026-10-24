import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// PRD v1.1 §11 event taxonomy (PR-013): the events TipMe did not record yet. Same rules as
// every analytics event: anonymous, deduplicated, off in production until D-07.
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
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
      RATE_LIMIT_ANALYTICS_PER_MIN: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body, extra = {}) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie, extra),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const named = async (name, handle) =>
  (
    await database.pool.query(
      `SELECT count(*)::int AS n FROM analytics_events WHERE name = $1 AND handle = $2`,
      [name, handle],
    )
  ).rows[0].n;

test('a page records profile_created once, and profile_published only the first time it goes live', async () => {
  const { cookie } = await signIn(stack.api, '+2348031310001');
  await call('POST', '/v1/me/page', cookie, { handle: 'events_ada' });
  assert.equal(await named('profile_created', 'events_ada'), 1);
  assert.equal(await named('profile_published', 'events_ada'), 0);
  for (const state of ['live', 'not_live', 'live'])
    await call('PUT', '/v1/me/page/state', cookie, { state });
  assert.equal(await named('profile_published', 'events_ada'), 1);
});

test('a withdrawal records payout_requested, and payout_paid_verified once the provider confirms it', async () => {
  const { cookie } = await signIn(stack.api, '+2348031310002');
  await call('POST', '/v1/me/page', cookie, { handle: 'events_tobi' });
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'events_tobi',
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
      body: JSON.stringify({ quoteId: quote.data.quoteId }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
  for (let i = 0; i < 50; i++) {
    const { availableMinor } = (
      await (await call('GET', '/v1/me/dashboard', cookie)).json()
    ).data;
    if (BigInt(availableMinor) > 0n) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const withdrawal = await call(
    'POST',
    '/v1/me/withdrawals',
    cookie,
    { amountMinor: '100000' },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(withdrawal.status, 201);
  assert.equal(await named('payout_requested', 'events_tobi'), 1);
  // The pretend bank pays at once; reconciliation confirms it and the worker records it.
  const { reconcilePayouts } =
    await import('../../packages/database/dist/index.js');
  const { createMockProvider } =
    await import('../../packages/payments/dist/index.js');
  const { Redis, REDIS_URL } = await import('./helpers.mjs');
  const redis = new Redis(REDIS_URL);
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
  for (let i = 0; i < 80; i++) {
    if ((await named('payout_paid_verified', 'events_tobi')) === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await named('payout_paid_verified', 'events_tobi'), 1);
});

test('the browser may send landing_viewed and checkout_opened', async () => {
  for (const name of ['landing_viewed', 'checkout_opened']) {
    const response = await fetch(`${stack.api}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ name, flowId: randomUUID() }),
    });
    assert.equal(response.status, 202, name);
  }
  const { rows } = await database.pool.query(
    `SELECT name FROM analytics_events WHERE name IN ('landing_viewed', 'checkout_opened') ORDER BY name`,
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['checkout_opened', 'landing_viewed'],
  );
});
