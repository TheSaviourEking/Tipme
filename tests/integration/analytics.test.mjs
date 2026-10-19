import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  purgeAnalytics,
  recordClientEvent,
  rollupAnalytics,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { WEB, opsSignIn, startStack } from './helpers.mjs';

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

const q = (sql, params) =>
  database.pool.query(sql, params).then((result) => result.rows);
const send = (api, body, headers = {}) =>
  fetch(`${api}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: WEB,
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari',
      ...headers,
    },
    body: JSON.stringify(body),
  });
const rowsFor = (flowId) =>
  q('SELECT * FROM analytics_events WHERE flow_id = $1', [flowId]);

test('an allowed event is stored anonymously: minute bucket, device class, no IP, agent or URL', async () => {
  const flowId = randomUUID();
  const response = await send(stack.api, {
    name: 'profile_viewed',
    flowId,
    surface: 'profile',
    channel: 'qr',
    handle: 'Tobi',
    returning: false,
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('set-cookie'), null);
  const [row] = await rowsFor(flowId);
  assert.equal(row.name, 'profile_viewed');
  assert.equal(row.handle, 'tobi');
  assert.equal(row.channel, 'qr');
  assert.equal(row.device, 'mobile');
  assert.equal(row.at_minute.getUTCSeconds(), 0);
  assert.equal(row.at_minute.getUTCMilliseconds(), 0);
  const columns = (
    await q(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_events'`,
    )
  ).map((c) => c.column_name);
  for (const forbidden of ['ip', 'user_agent', 'referrer', 'url', 'user_id'])
    assert.equal(columns.includes(forbidden), false, forbidden);
});

test('unknown properties, unknown names and server-only outcomes are refused, and nothing is stored (Review Focus 4)', async () => {
  const flowId = randomUUID();
  for (const body of [
    { name: 'profile_viewed', flowId, message: 'hello' },
    { name: 'profile_viewed', flowId, phone: '+2348031234567' },
    { name: 'profile_viewed', flowId, handle: '0803 123' },
    { name: 'whatever', flowId },
    { name: 'tip_completed', flowId },
  ]) {
    const response = await send(stack.api, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, 'VALIDATION_FAILED');
  }
  assert.equal((await rowsFor(flowId)).length, 0);
});

test('a handle that is not a real page is dropped, so a number cannot be smuggled in as one', async () => {
  const flowId = randomUUID();
  assert.equal(
    (
      await send(stack.api, {
        name: 'profile_viewed',
        flowId,
        handle: '08031234567',
      })
    ).status,
    202,
  );
  const [row] = await rowsFor(flowId);
  assert.equal(row.handle, null);
});

test('Global Privacy Control or Do Not Track on the request: accepted, not stored', async () => {
  for (const headers of [{ 'sec-gpc': '1' }, { dnt: '1' }]) {
    const flowId = randomUUID();
    const response = await send(
      stack.api,
      { name: 'profile_viewed', flowId },
      headers,
    );
    assert.equal(response.status, 202);
    assert.equal((await rowsFor(flowId)).length, 0);
  }
});

test('the events route is cross-origin from the web app but never credentialed', async () => {
  const preflight = await fetch(`${stack.api}/v1/events`, {
    method: 'OPTIONS',
    headers: {
      origin: WEB,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), WEB);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
});

test('with collection off nothing is stored; the limit is per client per minute', async () => {
  const off = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      ANALYTICS_ENABLED: 'false',
      RATE_LIMIT_ANALYTICS_PER_MIN: '5',
    },
  });
  try {
    // The limiter fails open while Redis is still connecting; wait until the API is ready.
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (await fetch(`${off.api}/health/ready`)).status !== 200
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    const flowId = randomUUID();
    const statuses = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (await send(off.api, { name: 'amount_selected', flowId })).status,
      );
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
    assert.equal((await rowsFor(flowId)).length, 0);
    // The admin numbers say so, so an empty funnel is never mistaken for no visitors.
    const owner = await opsSignIn(off.api, database.db, '+2348031110001');
    const health = await fetch(`${off.api}/v1/ops/metrics/health`, {
      headers: { cookie: owner.cookie },
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).data.collecting, false);
  } finally {
    await off.stop();
  }
});

test('the worker records a completed tip once as a server event', async () => {
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
      body: JSON.stringify({ quoteId: quote.data.quoteId }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
  const key = `tip_completed.${intent.data.tipId}`;
  const deadline = Date.now() + 10_000;
  let rows = [];
  while (Date.now() < deadline && rows.length === 0) {
    rows = await q('SELECT * FROM analytics_events WHERE dedupe_key = $1', [
      key,
    ]);
    if (rows.length === 0) await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'tip_completed');
  assert.equal(rows[0].handle, 'tobi');
  assert.equal(rows[0].flow_id, null);
});

test('the daily rollup counts visits, returning visits, channels and events, and can be rerun', async () => {
  const day = '2026-09-01';
  const at = new Date(`${day}T12:00:00Z`);
  const a = randomUUID();
  const b = randomUUID();
  const record = (event) =>
    recordClientEvent(database.db, { event, device: 'mobile', now: at });
  await record({
    name: 'profile_viewed',
    flowId: a,
    channel: 'qr',
    handle: 'tobi',
    returning: false,
  });
  await record({
    name: 'profile_viewed',
    flowId: a,
    channel: 'direct',
    handle: 'tobi',
    returning: false,
  });
  await record({
    name: 'profile_viewed',
    flowId: b,
    channel: 'instagram',
    handle: 'tobi',
    returning: true,
  });
  await record({ name: 'amount_selected', flowId: a, handle: 'tobi' });
  await record({ name: 'amount_selected', flowId: b, handle: 'tobi' });
  for (let run = 0; run < 2; run++) {
    await rollupAnalytics(database.db, { date: day });
    const metrics = Object.fromEntries(
      (
        await q(
          `SELECT metric, dimension, value::int AS value FROM analytics_daily WHERE date = $1`,
          [day],
        )
      ).map((r) => [`${r.metric}|${r.dimension}`, r.value]),
    );
    assert.equal(metrics['visits|'], 2);
    assert.equal(metrics['returning_visits|'], 1);
    assert.equal(metrics['visits_by_channel|qr'], 1);
    assert.equal(metrics['visits_by_channel|instagram'], 1);
    assert.equal(metrics['visits_by_channel|direct'], undefined);
    assert.equal(metrics['visits_by_handle|tobi'], 2);
    assert.equal(metrics['events.amount_selected|'], 2);
    assert.equal(metrics['events.profile_viewed|qr'], 1);
  }
});

test('raw events older than 90 days are purged; newer ones stay', async () => {
  const now = new Date();
  const old = randomUUID();
  const recent = randomUUID();
  await recordClientEvent(database.db, {
    event: { name: 'profile_viewed', flowId: old },
    device: 'desktop',
    now: new Date(now.getTime() - 91 * 86_400_000),
  });
  await recordClientEvent(database.db, {
    event: { name: 'profile_viewed', flowId: recent },
    device: 'desktop',
    now: new Date(now.getTime() - 89 * 86_400_000),
  });
  await purgeAnalytics(database.db, {
    before: new Date(now.getTime() - 90 * 86_400_000),
  });
  assert.equal((await rowsFor(old)).length, 0);
  assert.equal((await rowsFor(recent)).length, 1);
});
