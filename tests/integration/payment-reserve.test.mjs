import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { checkReserve } from '../../packages/database/dist/index.js';
import { handlePaymentReserve } from '../../apps/worker/dist/handlers/payment-reserve.js';
import { runUnlessRunning } from '../../apps/worker/dist/run-lock.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  opsSignIn,
  startStack,
  uniquePrefix,
} from './helpers.mjs';
import { createServer } from 'node:http';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const THRESHOLD = 100_000n; // ₦1,000 in kobo
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-11-01T09:00:00Z');
const at = (ms) => new Date(T0 + ms);

let database;
let stack;
let gated;
let owner;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB },
  });
  // A private preview copy (staging), to show the route stays open without the preview cookie.
  gated = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: 'https://staging.example.test',
      DEPLOYMENT_MODE: 'preview',
      PREVIEW_PASSWORD: 'staging-preview-password-for-tests-only!',
    },
  });
});
after(async () => {
  await gated.stop();
  await stack.stop();
  await database.close();
});
beforeEach(() => database.pool.query('DELETE FROM payment_reserve_readings'));

/** A stand-in for the provider adapter: only the platform balance read. */
const provider = (balance, name = 'bachs-live') => ({
  name,
  async platformBalance(currency) {
    assert.equal(currency, 'NGN');
    if (balance instanceof Error) throw balance;
    return { availableMinor: balance };
  },
});

/** Runs checks and collects what would have been sent. */
function reserve() {
  const sent = [];
  const alert = async (text) => {
    sent.push(text);
  };
  return {
    sent,
    check: (balance, ms, extra = {}) =>
      checkReserve(database.db, {
        provider: provider(balance),
        thresholdMinor: THRESHOLD,
        alert: extra.alert ?? alert,
        now: at(ms),
      }),
  };
}

const rows = async () =>
  (
    await database.pool.query(
      `SELECT provider, currency, available_minor::text AS available, threshold_minor::text AS threshold,
              low, alerted_at FROM payment_reserve_readings ORDER BY read_at`,
    )
  ).rows;

const health = async (path = '/health/payments', api = stack.api) =>
  fetch(`${api}${path}`);

test('a balance below ₦1,000 alerts once and shows on the Overview', async () => {
  const { sent, check } = reserve();
  assert.deepEqual(await check(99_999n, 0), { low: true, alerted: true });
  // The next 15-minute runs are still low but say nothing.
  assert.deepEqual(await check(99_000n, 15 * MINUTE), {
    low: true,
    alerted: false,
  });
  assert.deepEqual(await check(98_000n, 30 * MINUTE), {
    low: true,
    alerted: false,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /low/i);
  assert.match(sent[0], /₦999\.99/);
  assert.match(sent[0], /₦1,000/);

  const all = await rows();
  assert.equal(all.length, 3);
  assert.deepEqual(
    { ...all[2], alerted_at: null },
    {
      provider: 'bachs-live',
      currency: 'NGN',
      available: '98000',
      threshold: '100000',
      low: true,
      alerted_at: null,
    },
  );

  owner ??= await opsSignIn(stack.api, database.db, '+2348031110009');
  const overview = await (
    await fetch(`${stack.api}/v1/ops/metrics/health`, {
      headers: { cookie: owner.cookie },
    })
  ).json();
  assert.deepEqual(
    { ...overview.data.metrics.reserve, readAt: 'x' },
    {
      provider: 'bachs-live',
      currency: 'NGN',
      availableMinor: '98000',
      thresholdMinor: '100000',
      low: true,
      readAt: 'x',
    },
  );
  assert.equal(
    overview.data.metrics.reserve.readAt,
    at(30 * MINUTE).toISOString(),
  );
});

test('a balance of exactly ₦1,000 is not low, and nothing is sent', async () => {
  const { sent, check } = reserve();
  assert.deepEqual(await check(100_000n, 0), { low: false, alerted: false });
  assert.deepEqual(sent, []);
  assert.equal((await rows())[0].low, false);
});

test('it alerts again after recovering and dropping, and every 6 hours while low', async () => {
  const { sent, check } = reserve();
  assert.equal((await check(50_000n, 0)).alerted, true);
  assert.equal((await check(50_000n, 6 * HOUR - MINUTE)).alerted, false);
  assert.equal((await check(50_000n, 6 * HOUR)).alerted, true);
  assert.equal((await check(50_000n, 11 * HOUR)).alerted, false);
  assert.equal((await check(50_000n, 12 * HOUR)).alerted, true);
  assert.equal(sent.length, 3);

  // Topped up, then dropped again: a new first low alerts straight away.
  assert.deepEqual(await check(500_000n, 12 * HOUR + 15 * MINUTE), {
    low: false,
    alerted: false,
  });
  assert.deepEqual(await check(20_000n, 12 * HOUR + 30 * MINUTE), {
    low: true,
    alerted: true,
  });
  assert.equal(sent.length, 4);
});

test('a failed balance read is recorded as unknown and alerts as unreadable', async () => {
  const { sent, check } = reserve();
  const failure = new Error('connect ECONNREFUSED secret-token-abc123');
  assert.deepEqual(await check(failure, 0), { low: null, alerted: true });
  assert.deepEqual(await check(failure, 15 * MINUTE), {
    low: null,
    alerted: false,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /could not be read|unreadable/i);
  assert.equal(sent[0].includes('secret-token-abc123'), false);
  assert.equal(sent[0].includes('ECONNREFUSED'), false);

  const all = await rows();
  assert.equal(all[0].available, null);
  assert.equal(all[0].low, null);
  assert.equal(all[0].threshold, '100000');

  // The same 6-hour rule.
  assert.equal((await check(failure, 6 * HOUR)).alerted, true);
  assert.equal(sent.length, 2);
  // A good read ends it; failing again later is a new first alert.
  assert.equal((await check(900_000n, 6 * HOUR + 15 * MINUTE)).alerted, false);
  assert.equal((await check(failure, 6 * HOUR + 30 * MINUTE)).alerted, true);
});

test('low and unreadable are told apart, each with its own first alert and 6-hour rule', async () => {
  const { sent, check } = reserve();
  assert.equal((await check(10_000n, 0)).alerted, true); // low
  assert.equal((await check(new Error('down'), 15 * MINUTE)).alerted, true); // unreadable
  // Back to a low reading inside 6 hours of the low alert: not repeated.
  assert.equal((await check(10_000n, 30 * MINUTE)).alerted, false);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /low/i);
  assert.match(sent[1], /could not be read|unreadable/i);
});

test('an alert that cannot be sent is recorded, not thrown, and tried again on the next run', async () => {
  const { sent, check } = reserve();
  const broken = async () => {
    throw new Error('https://hooks.example.test/services/T000/B000/SECRET');
  };
  const first = await check(10_000n, 0, { alert: broken });
  assert.deepEqual(first, { low: true, alerted: false, alertFailed: true });
  assert.equal((await rows())[0].alerted_at, null);
  // Next run: still the first alert of this low spell, so it is sent now.
  assert.deepEqual(await check(10_000n, 15 * MINUTE), {
    low: true,
    alerted: true,
  });
  assert.equal(sent.length, 1);
  assert.equal((await check(10_000n, 30 * MINUTE)).alerted, false);
});

test('readings of another provider do not count towards this one', async () => {
  const { sent } = reserve();
  const options = (name, ms) => ({
    provider: provider(10_000n, name),
    thresholdMinor: THRESHOLD,
    alert: async (text) => {
      sent.push(text);
    },
    now: at(ms),
  });
  assert.equal(
    (await checkReserve(database.db, options('bachs-sandbox', 0))).alerted,
    true,
  );
  assert.equal(
    (await checkReserve(database.db, options('bachs-live', MINUTE))).alerted,
    true,
  );
  assert.equal(sent.length, 2);
});

test('/health/payments says low without revealing the amount', async () => {
  // Nothing read yet (a copy without a Bachs provider): nothing to report, not an alarm.
  let response = await health();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    data: { reserveLow: false, unreadable: false, readAt: null },
  });

  const { check } = reserve();
  await check(250_000n, 0);
  assert.deepEqual((await (await health()).json()).data, {
    reserveLow: false,
    unreadable: false,
    readAt: at(0).toISOString(),
  });

  await check(99_999n, 15 * MINUTE);
  response = await health();
  const text = await response.text();
  assert.deepEqual(JSON.parse(text).data, {
    reserveLow: true,
    unreadable: false,
    readAt: at(15 * MINUTE).toISOString(),
  });
  for (const hidden of [
    '99999',
    '99,999',
    '100000',
    'available',
    'threshold',
    'bachs',
  ])
    assert.equal(text.toLowerCase().includes(hidden), false, hidden);

  // Unreadable cannot be confirmed fine, so a watcher that only reads reserveLow still alarms.
  await check(new Error('down'), 30 * MINUTE);
  assert.deepEqual((await (await health()).json()).data, {
    reserveLow: true,
    unreadable: true,
    readAt: at(30 * MINUTE).toISOString(),
  });
});

test('/health/payments needs no preview cookie, like the other health routes', async () => {
  const open = (path) => health(path, gated.api);
  assert.equal((await open('/health/payments')).status, 200);
  // The gate is really on: another route is refused without the cookie.
  assert.equal((await open('/v1/profiles/ada')).status, 401);
  // Nothing sneaks past the gate by looking like it.
  assert.equal((await open('/health/payments/x')).status, 401);
  assert.equal((await open('/health//payments')).status, 401);
});

/** A local stand-in for the alert route; it records what it is sent. */
async function alertRoute(status = 200) {
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(status).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}/services/T0/B0/very-secret-token`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the worker handler sends the alert to the alert route and logs no address', async () => {
  const route = await alertRoute();
  const logs = [];
  try {
    const options = (balance, ms) => ({
      db: database.db,
      provider: provider(balance),
      thresholdMinor: THRESHOLD,
      alertWebhookUrl: route.url,
      log: (entry) => logs.push(entry),
      now: at(ms),
    });
    assert.equal(await handlePaymentReserve(options(10_000n, 0)), 'low');
    assert.equal(await handlePaymentReserve(options(10_000n, MINUTE)), 'low');
    assert.equal(
      await handlePaymentReserve(options(900_000n, 2 * MINUTE)),
      'ok',
    );
    assert.equal(
      await handlePaymentReserve(options(new Error('down'), 3 * MINUTE)),
      'unreadable',
    );
    assert.equal(route.received.length, 2);
    assert.equal(route.received[0].path, '/services/T0/B0/very-secret-token');
    assert.match(route.received[0].body.text, /low/i);
    assert.match(route.received[1].body.text, /could not be read/i);
    assert.equal(JSON.stringify(logs).includes('very-secret-token'), false);
  } finally {
    await route.close();
  }
});

test('an alert route that is down or refuses is logged by name only, and the reading is kept', async () => {
  const route = await alertRoute(500);
  const logs = [];
  try {
    const outcome = await handlePaymentReserve({
      db: database.db,
      provider: provider(10_000n),
      thresholdMinor: THRESHOLD,
      alertWebhookUrl: route.url,
      log: (entry) => logs.push(entry),
      now: at(0),
    });
    assert.equal(outcome, 'low');
    assert.deepEqual(logs, [{ event: 'reserve.alert_failed' }]);
    assert.equal((await rows())[0].alerted_at, null);
  } finally {
    await route.close();
  }
  // Nothing listening at all.
  const down = await handlePaymentReserve({
    db: database.db,
    provider: provider(10_000n),
    thresholdMinor: THRESHOLD,
    alertWebhookUrl: route.url,
    log: (entry) => logs.push(entry),
    now: at(MINUTE),
  });
  assert.equal(down, 'low');
  assert.equal(JSON.stringify(logs).includes('very-secret-token'), false);
  assert.equal((await rows()).length, 2);
});

test('the run lock works on real Redis: an overlapping run is skipped, and the lock is freed after', async () => {
  const redis = new Redis(REDIS_URL);
  const key = `${uniquePrefix()}:lock:payments.reserve`;
  try {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const first = runUnlessRunning(redis, { key, ttlMs: 5000 }, () => held);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      await runUnlessRunning(redis, { key, ttlMs: 5000 }, async () => 'no'),
      { ran: false },
    );
    release('first');
    assert.deepEqual(await first, { ran: true, value: 'first' });
    assert.equal(await redis.exists(key), 0);
    assert.deepEqual(
      await runUnlessRunning(redis, { key, ttlMs: 5000 }, async () => 'again'),
      { ran: true, value: 'again' },
    );
  } finally {
    await redis.del(key);
    redis.disconnect();
  }
});
