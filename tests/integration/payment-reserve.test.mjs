import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  checkReserve,
  latestReserveReading,
  purgeReserveReadings,
} from '../../packages/database/dist/index.js';
import { PaymentsHealthController } from '../../apps/api/dist/health/payments-health.controller.js';
import { handlePaymentReserve } from '../../apps/worker/dist/handlers/payment-reserve.js';
import { runUnlessRunning } from '../../apps/worker/dist/run-lock.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  opsSignIn,
  signIn,
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
              low, alerted_at, alert_claimed_at FROM payment_reserve_readings ORDER BY read_at`,
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
      alert_claimed_at: null,
    },
  );

  owner ??= await opsSignIn(stack.api, database.db, '+2348031110009');
  const overview = await (
    await fetch(`${stack.api}/v1/ops/metrics/health`, {
      headers: { cookie: owner.cookie },
    })
  ).json();
  assert.deepEqual(
    { ...overview.data.metrics.reserve, readAt: 'x', stale: 'x' },
    {
      provider: 'bachs-live',
      currency: 'NGN',
      availableMinor: '98000',
      thresholdMinor: '100000',
      low: true,
      readAt: 'x',
      stale: 'x',
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
  // The claim is given back, so the next run is not told someone is still sending.
  assert.equal((await rows())[0].alert_claimed_at, null);
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

test('two checks at once on the same low balance send one alert, and the second does not wait for the send', async () => {
  const sent = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  // The first alert is still being sent when the second check runs.
  const slow = async (text) => {
    sent.push(text);
    await gate;
  };
  const run = () =>
    checkReserve(database.db, {
      provider: provider(10_000n),
      thresholdMinor: THRESHOLD,
      alert: slow,
      now: at(0),
    });
  const first = run();
  const second = run();
  // The second answers while the first send is still blocked: no lock is held across the send.
  assert.deepEqual(await second, { low: true, alerted: false });
  assert.equal(sent.length, 1);
  release();
  assert.deepEqual(await first, { low: true, alerted: true });
  assert.equal(sent.length, 1);
  const all = await rows();
  assert.equal(all.length, 2);
  assert.equal(all.filter((r) => r.alerted_at !== null).length, 1);
});

test('a burst of checks at once sends one alert', async () => {
  const sent = [];
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      checkReserve(database.db, {
        provider: provider(10_000n),
        thresholdMinor: THRESHOLD,
        alert: async (text) => {
          sent.push(text);
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
        now: at(0),
      }),
    ),
  );
  assert.equal(sent.length, 1);
  assert.equal(results.filter((r) => r.alerted).length, 1);
});

test('a check waits for the provider lock to decide, but reads the balance without it', async () => {
  // Another session holds the provider's advisory lock (as a concurrent check would mid-decision).
  const holder = await database.pool.connect();
  let reads = 0;
  try {
    await holder.query('BEGIN');
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtext('payment_reserve:bachs-live'))",
    );
    const sent = [];
    let finished = false;
    const pending = checkReserve(database.db, {
      provider: {
        name: 'bachs-live',
        async platformBalance() {
          reads += 1;
          return { availableMinor: 10_000n };
        },
      },
      thresholdMinor: THRESHOLD,
      alert: async (text) => {
        sent.push(text);
      },
      now: at(0),
    }).finally(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The provider was asked, but nothing is decided or written until the lock is free.
    assert.equal(reads, 1);
    assert.equal(finished, false);
    assert.equal((await rows()).length, 0);
    await holder.query('COMMIT');
    assert.deepEqual(await pending, { low: true, alerted: true });
    assert.equal(sent.length, 1);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('an alert someone is still sending holds back a second check; an abandoned claim does not', async () => {
  const { sent, check } = reserve();
  const claim = (minutesAgo) =>
    database.pool.query(
      `INSERT INTO payment_reserve_readings
         (id, provider, currency, available_minor, threshold_minor, low, read_at, alert_claimed_at)
       VALUES (gen_random_uuid(), 'bachs-live', 'NGN', 10000, 100000, true, $1, $1)`,
      [at(-minutesAgo * MINUTE)],
    );
  // Claimed a minute ago and not finished: a sender is at work.
  await claim(1);
  assert.deepEqual(await check(10_000n, 0), { low: true, alerted: false });
  assert.deepEqual(sent, []);
  // Claimed ten minutes ago and never finished: that worker died, so this run sends it.
  await database.pool.query('DELETE FROM payment_reserve_readings');
  await claim(10);
  assert.deepEqual(await check(10_000n, 0), { low: true, alerted: true });
  assert.equal(sent.length, 1);
});

test('readings older than 90 days are purged, newer ones kept', async () => {
  const insert = (days) =>
    database.pool.query(
      `INSERT INTO payment_reserve_readings
         (id, provider, currency, available_minor, threshold_minor, low, read_at)
       VALUES (gen_random_uuid(), 'bachs-live', 'NGN', 500000, 100000, false, $1)`,
      [new Date(T0 - days * 24 * HOUR)],
    );
  await insert(91);
  await insert(120);
  await insert(89);
  await insert(0);
  const deleted = await purgeReserveReadings(database.db, {
    before: new Date(T0 - 90 * 24 * HOUR),
  });
  assert.equal(deleted, 2);
  assert.equal((await rows()).length, 2);
});

test('/health/payments says low without revealing the amount', async () => {
  // Nothing read yet (a copy without a Bachs provider): nothing to report, not an alarm.
  let response = await health();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    data: { reserveLow: false, unreadable: false, stale: false, readAt: null },
  });

  const { check } = reserve();
  await check(250_000n, 0);
  assert.deepEqual((await (await health()).json()).data, {
    reserveLow: false,
    unreadable: false,
    stale: false,
    readAt: at(0).toISOString(),
  });

  await check(99_999n, 15 * MINUTE);
  response = await health();
  const text = await response.text();
  assert.deepEqual(JSON.parse(text).data, {
    reserveLow: true,
    unreadable: false,
    stale: false,
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

  // Unreadable is its own field: reserveLow means low and nothing else.
  await check(new Error('down'), 30 * MINUTE);
  assert.deepEqual((await (await health()).json()).data, {
    reserveLow: false,
    unreadable: true,
    stale: false,
    readAt: at(30 * MINUTE).toISOString(),
  });
});

/** The route's answer for a copy configured like this, read straight from the controller. */
const answerFor = async (config) =>
  (
    await new PaymentsHealthController(config, {
      db: database.db,
    }).payments()
  ).data;
const LIVE = { PAYMENT_PROVIDER: 'bachs-live', PAYMENTS_LIVE_ENABLED: true };
const ago = (ms) => new Date(Date.now() - ms);

test('/health/payments says stale when live payments are on and the checks have stopped', async () => {
  // Live payments on and nothing ever read: the worker is not checking.
  assert.deepEqual(await answerFor(LIVE), {
    reserveLow: false,
    unreadable: false,
    stale: true,
    readAt: null,
  });
  const read = async (ms) => {
    await database.pool.query('DELETE FROM payment_reserve_readings');
    await checkReserve(database.db, {
      provider: provider(500_000n),
      thresholdMinor: THRESHOLD,
      alert: async () => undefined,
      now: ago(ms),
    });
  };
  await read(10 * MINUTE);
  assert.equal((await answerFor(LIVE)).stale, false);
  await read(44 * MINUTE);
  assert.equal((await answerFor(LIVE)).stale, false);
  await read(46 * MINUTE);
  assert.equal((await answerFor(LIVE)).stale, true);
  await read(3 * HOUR);
  assert.equal((await answerFor(LIVE)).stale, true);
});

test('a missing or old reading is not stale while payments are off or the provider is not Bachs live', async () => {
  for (const config of [
    { PAYMENT_PROVIDER: 'bachs-live', PAYMENTS_LIVE_ENABLED: false },
    { PAYMENT_PROVIDER: 'bachs-sandbox', PAYMENTS_LIVE_ENABLED: false },
    { PAYMENT_PROVIDER: 'mock', PAYMENTS_LIVE_ENABLED: false },
  ]) {
    assert.equal((await answerFor(config)).stale, false, 'no reading');
    await checkReserve(database.db, {
      provider: provider(500_000n),
      thresholdMinor: THRESHOLD,
      alert: async () => undefined,
      now: ago(5 * HOUR),
    });
    assert.equal((await answerFor(config)).stale, false, 'old reading');
    await database.pool.query('DELETE FROM payment_reserve_readings');
  }
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

test('an alert with no address is not counted as sent, so the timer is not spent', async () => {
  const logs = [];
  const options = (url, ms) => ({
    db: database.db,
    provider: provider(10_000n),
    thresholdMinor: THRESHOLD,
    alertWebhookUrl: url,
    log: (entry) => logs.push(entry),
    now: at(ms),
  });
  assert.equal(await handlePaymentReserve(options(undefined, 0)), 'low');
  assert.equal(await handlePaymentReserve(options(undefined, MINUTE)), 'low');
  // Said in the log each time, never recorded as delivered.
  assert.equal(
    logs.filter((l) => l.event === 'reserve.alert_unrouted').length,
    2,
  );
  assert.deepEqual(
    (await rows()).map((r) => r.alerted_at),
    [null, null],
  );
  // The address is added mid-spell: the very next run sends the first alert at once.
  const route = await alertRoute();
  try {
    assert.equal(
      await handlePaymentReserve(options(route.url, 2 * MINUTE)),
      'low',
    );
    assert.equal(route.received.length, 1);
  } finally {
    await route.close();
  }
});

test('each reserve check purges readings older than 90 days', async () => {
  await database.pool.query(
    `INSERT INTO payment_reserve_readings
       (id, provider, currency, available_minor, threshold_minor, low, read_at)
     VALUES (gen_random_uuid(), 'bachs-live', 'NGN', 500000, 100000, false, $1),
            (gen_random_uuid(), 'bachs-live', 'NGN', 500000, 100000, false, $2)`,
    [new Date(T0 - 91 * 24 * HOUR), new Date(T0 - 30 * 24 * HOUR)],
  );
  await handlePaymentReserve({
    db: database.db,
    provider: provider(500_000n),
    thresholdMinor: THRESHOLD,
    alertWebhookUrl: undefined,
    log: () => undefined,
    now: at(0),
  });
  // The 30-day-old one and this check's own reading remain.
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

test('the latest reading is found through its index, without sorting the table', async () => {
  await database.pool.query('DELETE FROM payment_reserve_readings');
  // Capture the statement the operation really sends, then ask Postgres how it would run it.
  const sent = [];
  const query = database.pool.query;
  database.pool.query = function capture(...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (text?.includes('payment_reserve_readings'))
      sent.push({ text, values: args[0]?.values ?? args[1] ?? [] });
    return query.apply(this, args);
  };
  try {
    await latestReserveReading(database.db);
  } finally {
    database.pool.query = query;
  }
  assert.equal(sent.length, 1);
  const { text, values } = sent[0];
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    // EXPLAIN takes no parameters: write them in (here only the row limit).
    const literal = text.replace(/\$(\d+)/g, (_, n) => String(values[n - 1]));
    const { rows } = await client.query(`EXPLAIN ${literal}`);
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(plan, /payment_reserve_readings_read_at/);
    assert.doesNotMatch(plan, /Sort/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('the Overview marks a reading stale after 45 minutes, and the flag follows the reading', async () => {
  owner ??= await opsSignIn(stack.api, database.db, '+2348031110009');
  const overview = async () =>
    (
      await (
        await fetch(`${stack.api}/v1/ops/metrics/health`, {
          headers: { cookie: owner.cookie },
        })
      ).json()
    ).data.metrics.reserve;
  assert.equal(await overview(), null);
  const read = async (ms, balance) => {
    await checkReserve(database.db, {
      provider: provider(balance),
      thresholdMinor: THRESHOLD,
      alert: async () => undefined,
      now: ago(ms),
    });
  };
  await read(10 * MINUTE, 500_000n);
  assert.equal((await overview()).stale, false);
  await database.pool.query('DELETE FROM payment_reserve_readings');
  await read(50 * MINUTE, 10_000n);
  // A stale reading still says what it said: low.
  const stale = await overview();
  assert.equal(stale.stale, true);
  assert.equal(stale.low, true);
});

test('only staff who may view analytics see the reserve amount', async () => {
  const secret = 98_765n;
  await checkReserve(database.db, {
    provider: provider(secret),
    thresholdMinor: THRESHOLD,
    alert: async () => undefined,
    now: ago(MINUTE),
  });
  const get = (cookie) =>
    fetch(`${stack.api}/v1/ops/metrics/health`, {
      headers: cookie ? { cookie } : {},
    });
  const leaks = async (response) => {
    const text = await response.text();
    return text.includes('98765') || text.includes('"reserve"');
  };

  // Signed out, and a recipient who is not staff: nothing, and not even a hint the route exists.
  const anonymous = await get();
  assert.equal(anonymous.status, 404);
  assert.equal(await leaks(anonymous), false);
  const recipient = await signIn(stack.api, '+2348031110031');
  const asRecipient = await get(recipient.cookie);
  assert.equal(asRecipient.status, 404);
  assert.equal(await leaks(asRecipient), false);

  // Staff whose role lacks analytics.view are refused.
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('no-analytics', 'No analytics') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('no-analytics', 'issues.view') ON CONFLICT DO NOTHING`,
  );
  const staff = await opsSignIn(stack.api, database.db, '+2348031110032');
  await database.pool.query(
    `UPDATE staff SET role_id = 'no-analytics' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348031110032')`,
  );
  const refused = await get(staff.cookie);
  assert.equal(refused.status, 403);
  assert.equal(await leaks(refused), false);

  // With analytics.view they do (the same permission as the rest of the Overview).
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('no-analytics', 'analytics.view') ON CONFLICT DO NOTHING`,
  );
  const allowed = await get(staff.cookie);
  assert.equal(allowed.status, 200);
  assert.equal(
    (await allowed.json()).data.metrics.reserve.availableMinor,
    '98765',
  );
});
