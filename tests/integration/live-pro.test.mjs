import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createSession,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  browserHeaders,
  openEventStream,
  startStack,
} from './helpers.mjs';

// Live updates for the rest of TipMe, Task 8 (addendum §3.7): a Pro purchase that leaves the open
// states sends `pro.changed` to the buyer's page, whatever the outcome, from the webhook path and
// from the worker's read-back; `profile.changed` still goes only when the plan changed.
// It resets its database in before(): on a shared database run it alone (--test-concurrency=1).
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const API_ENV = {
  WEB_ORIGIN: WEB,
  LIVE_UPDATES_ENABLED: 'true',
  LIVE_HEARTBEAT_MS: '1000',
  PRO_BILLING_ENABLED: 'true',
  RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
  RATE_LIMIT_AUTH_PER_HOUR: '1000',
};

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  // The webhook path alone: this stack's read-back waits ten minutes, so it never settles first.
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: API_ENV,
    workerEnv: { RECONCILE_INTERVAL_MS: '600000' },
  });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const READY = /^data: \{"type":"ready"\}$/;
const frame = (type) => new RegExp(`^data: \\{"type":"${type}"\\}$`);
const has = (stream, type) => stream.frames.some((f) => frame(type).test(f));

async function owner(handle) {
  const { rows } = await database.pool.query(
    'SELECT id, user_id FROM profiles WHERE handle = $1',
    [handle],
  );
  const { token } = await createSession(database.db, {
    userId: rows[0].user_id,
    deviceLabel: 'Integration test',
  });
  return { profileId: rows[0].id, cookie: `tipme_session=${token}` };
}

/** Closed when the test ends, pass or fail: an open stream would hold the stack's shutdown. */
async function streamOf(t, api, cookie) {
  const stream = await openEventStream(`${api}/v1/me/events`, {
    cookie,
    origin: WEB,
  });
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  await stream.waitFor(READY);
  return stream;
}

async function buy(api, cookie) {
  const response = await fetch(`${api}/v1/me/pro/purchases`, {
    method: 'POST',
    headers: browserHeaders(cookie, { 'idempotency-key': randomUUID() }),
    body: JSON.stringify({ expectedAmountMinor: '500000' }),
  });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  return { ...data, reference: data.checkoutUrl.split('/').at(-1) };
}

/** The pretend partner's checkout: one signed webhook, which TipMe reads back. */
async function pay(api, reference, outcome) {
  const response = await fetch(
    `${api}/v1/mock-provider/checkout/${reference}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome, method: 'card' }),
    },
  );
  assert.equal(response.status, 201);
}

const statusOf = async (purchaseId) =>
  (
    await database.pool.query(
      'SELECT status FROM pro_purchases WHERE id = $1',
      [purchaseId],
    )
  ).rows[0].status;

test('a failed Pro payment reaches the buyer’s stream as pro.changed', async (t) => {
  const ada = await owner('ada');
  const stream = await streamOf(t, stack.api, ada.cookie);
  const purchase = await buy(stack.api, ada.cookie);
  await pay(stack.api, purchase.reference, 'decline');
  await stream.waitFor(frame('pro.changed'));
  assert.equal(await statusOf(purchase.purchaseId), 'FAILED');
  // Nothing about the plan changed: no profile.changed.
  await sleep(1500);
  assert.equal(has(stream, 'profile.changed'), false);
  for (const f of stream.frames.filter((f) => f.startsWith('data: ')))
    assert.deepEqual(Object.keys(JSON.parse(f.slice(6))), ['type']);
});

test('a paid Pro payment sends pro.changed and profile.changed; another person’s stream gets neither', async (t) => {
  const ada = await owner('ada');
  const tobi = await owner('tobi');
  const adaStream = await streamOf(t, stack.api, ada.cookie);
  const tobiStream = await streamOf(t, stack.api, tobi.cookie);
  const purchase = await buy(stack.api, ada.cookie);
  await pay(stack.api, purchase.reference, 'succeed');
  await adaStream.waitFor(frame('pro.changed'));
  await adaStream.waitFor(frame('profile.changed'));
  assert.equal(await statusOf(purchase.purchaseId), 'PAID');
  await sleep(1500);
  assert.equal(has(tobiStream, 'pro.changed'), false);
  assert.equal(has(tobiStream, 'profile.changed'), false);
  // One settle, one pro.changed: the read-back that found it already paid sends nothing more.
  assert.equal(
    adaStream.frames.filter((f) => frame('pro.changed').test(f)).length,
    1,
  );
});

test('a purchase the read-back expires sends pro.changed', async (t) => {
  // A second stack whose worker reads back every 300 ms, on its own queue prefix and live channel.
  const fast = await startStack({
    databaseUrl: database.url,
    apiEnv: API_ENV,
    workerEnv: { RECONCILE_INTERVAL_MS: '300', RECONCILE_MIN_AGE_MS: '0' },
  });
  const redis = new Redis(REDIS_URL);
  // after() hooks run in the order they are added, and an open stream holds the stack's stop: so
  // this one closes the stream itself first (streamOf's own close comes later and is harmless).
  let stream;
  t.after(async () => {
    stream?.close();
    await redis.quit();
    await fast.stop();
  });
  const tobi = await owner('tobi');
  stream = await streamOf(t, fast.api, tobi.cookie);
  const purchase = await buy(fast.api, tobi.cookie);
  // The checkout's time is up, then the pretend partner says it failed (no webhook): only the
  // worker's read-back can find out, and it expires the purchase.
  await database.pool.query(
    `UPDATE pro_purchases SET expires_at = now() - interval '1 minute' WHERE id = $1`,
    [purchase.purchaseId],
  );
  await redis.hset(
    `mockprovider:${fast.prefix}:payment:${purchase.reference}`,
    'status',
    'failed',
  );
  await stream.waitFor(frame('pro.changed'), 10_000);
  assert.equal(await statusOf(purchase.purchaseId), 'EXPIRED');
  assert.equal(has(stream, 'profile.changed'), false);
});
