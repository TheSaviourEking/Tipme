import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createPaymentIntent,
  createQuote,
  createSession,
  markAttemptInitiated,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  createMockProvider,
  planScenario,
  runScenario,
} from '../../packages/payments/dist/index.js';
import { randomUUID } from 'node:crypto';
import { ReadinessService } from '../../apps/api/dist/health/readiness.service.js';
import { LiveHubService } from '../../apps/api/dist/live/live-hub.service.js';
import {
  REDIS_URL,
  Redis,
  WEBHOOK_SECRET,
  WEB,
  browserHeaders,
  openEventStream,
  signIn,
  startStack,
} from './helpers.mjs';

// The live stream (spec §2): signals only, authenticated on every connect, and never held past its
// session. Written before the route: "a stream outlives requestTimeout" decides whether it works at all.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let phone = 0;
const nextPhone = () =>
  `+2348032${String(200000 + (phone += 1)).padStart(6, '0')}`;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      LIVE_UPDATES_ENABLED: 'true',
      LIVE_HEARTBEAT_MS: '1000',
      // Every test here connects from 127.0.0.1; the per-address limit has its own stack below.
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
    },
  });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const events = (cookie, origin = WEB) =>
  openEventStream(`${stack.api}/v1/me/events`, {
    ...(cookie ? { cookie } : {}),
    origin,
  });
const READY = /^data: \{"type":"ready"\}$/;

test('a stream outlives requestTimeout', { timeout: 30_000 }, async () => {
  const { cookie } = await signIn(stack.api, nextPhone());
  const stream = await events(cookie);
  assert.equal(stream.status, 200);
  assert.equal(
    stream.frames[0] ?? (await stream.waitFor(/^retry:/)),
    'retry: 5000',
  );
  await stream.waitFor(READY);
  const opened = Date.now();
  let ended = false;
  void stream.ended.then(() => (ended = true));
  await sleep(12_500);
  assert.equal(
    ended,
    false,
    'the stream must stay open past the 10 s request timeout',
  );
  assert.ok(Date.now() - opened >= 12_000);
  assert.ok(
    stream.frames.filter((f) => f === ': hb\nevent: hb\ndata: {}').length >= 1,
    'at least one heartbeat',
  );
  // Order: retry first, then ready, then heartbeats.
  assert.deepEqual(stream.frames.slice(0, 2), [
    'retry: 5000',
    'data: {"type":"ready"}',
  ]);
  stream.close();
});

test('401 without a session', async () => {
  const stream = await events(undefined);
  assert.equal(stream.status, 401);
  await stream.ended;
});

test('CORS: credentials for WEB_ORIGIN only', async () => {
  const { cookie } = await signIn(stack.api, nextPhone());
  const ours = await events(cookie, WEB);
  assert.equal(ours.headers['access-control-allow-origin'], WEB);
  assert.equal(ours.headers['access-control-allow-credentials'], 'true');
  ours.close();
  const theirs = await events(cookie, 'https://elsewhere.example');
  assert.equal(theirs.headers['access-control-allow-origin'], undefined);
  theirs.close();
});

test('the response headers are event-stream, no-store and no-transform, with X-Accel-Buffering: no', async () => {
  const { cookie } = await signIn(stack.api, nextPhone());
  const stream = await events(cookie);
  assert.equal(
    stream.headers['content-type'],
    'text/event-stream; charset=utf-8',
  );
  assert.equal(stream.headers['cache-control'], 'no-store, no-transform');
  assert.equal(stream.headers['x-accel-buffering'], 'no');
  assert.equal(stream.headers['content-encoding'], undefined);
  stream.close();
});

test('revoking the session closes the stream with session.ended', async () => {
  const number = nextPhone();
  const first = await signIn(stack.api, number);
  const second = await signIn(stack.api, number);
  const stream = await events(first.cookie);
  await stream.waitFor(READY);
  const response = await fetch(`${stack.api}/v1/me/sessions/sign-out-others`, {
    method: 'POST',
    headers: browserHeaders(second.cookie),
  });
  assert.equal(response.status, 204);
  await stream.waitFor(/^data: \{"type":"session.ended"\}$/);
  await stream.ended;
  // The session that stayed keeps its own stream.
  const kept = await events(second.cookie);
  await kept.waitFor(READY);
  kept.close();
});

test('a stream closes at its session’s expiresAt when that is sooner than 30 minutes', async () => {
  const { cookie, body } = await signIn(stack.api, nextPhone());
  await database.pool.query(
    `UPDATE sessions SET expires_at = now() + interval '2 seconds' WHERE user_id = $1`,
    [body.data.userId],
  );
  const started = Date.now();
  const stream = await events(cookie);
  await stream.waitFor(READY);
  await Promise.race([
    stream.ended,
    sleep(4000).then(() => assert.fail('the stream outlived its session')),
  ]);
  assert.ok(Date.now() - started < 4000);
});

test('a client that leaves during the connect leaves no stream behind (the race)', async () => {
  const { cookie } = await signIn(stack.api, nextPhone());
  const hub = stack.app.get(LiveHubService);
  const before = hub.counts().me;
  // Hold the connect inside its awaits: myProfileId reads profiles, which this lock blocks.
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE profiles IN ACCESS EXCLUSIVE MODE');
    const request = http.get(`${stack.api}/v1/me/events`, {
      headers: { cookie, origin: WEB, accept: 'text/event-stream' },
    });
    request.on('error', () => undefined);
    await sleep(300);
    // The tab closes while the API still waits on Postgres.
    request.destroy();
    await sleep(100);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  await sleep(500);
  assert.equal(hub.counts().me, before, 'no slot held for a client that left');
  // And the person's eight places are all still free.
  const open = [];
  for (let i = 0; i < 8; i += 1) {
    const stream = await events(cookie);
    assert.equal(stream.status, 200);
    open.push(stream);
  }
  for (const stream of open) stream.close();
});

test('the ninth stream for one user gets 429 LIVE_LIMIT', async () => {
  const { cookie } = await signIn(stack.api, nextPhone());
  const open = [];
  for (let i = 0; i < 8; i += 1) {
    const stream = await events(cookie);
    assert.equal(stream.status, 200);
    await stream.waitFor(READY);
    open.push(stream);
  }
  const ninth = await events(cookie);
  assert.equal(ninth.status, 429);
  await ninth.ended;
  assert.equal(JSON.parse(ninth.body).error.code, 'LIVE_LIMIT');
  // Closing one frees its place.
  open.pop().close();
  await sleep(200);
  const again = await events(cookie);
  assert.equal(again.status, 200);
  again.close();
  for (const stream of open) stream.close();
});

/** A session cookie for a demo page's owner, made directly (demo owners have no sign-in number). */
async function ownerCookie(handle) {
  const { rows } = await database.pool.query(
    'SELECT user_id FROM profiles WHERE handle = $1',
    [handle],
  );
  const { token } = await createSession(database.db, {
    userId: rows[0].user_id,
    deviceLabel: 'Integration test',
  });
  return `tipme_session=${token}`;
}

test('a pretend tip produces tips.changed and then notifications.changed on the recipient\u2019s stream and nothing on a second user\u2019s', async (t) => {
  const redis = new Redis(REDIS_URL);
  t.after(() => redis.quit());
  const mock = createMockProvider({
    redis,
    secret: WEBHOOK_SECRET,
    prefix: stack.prefix,
  });
  const ada = await events(await ownerCookie('ada'));
  const tobi = await events(await ownerCookie('tobi'));
  await ada.waitFor(READY);
  await tobi.waitFor(READY);
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  const { providerReference } = await mock.initializePayment({
    attemptId,
    amountMinor: 200000n,
    currency: 'NGN',
    scenario: 'succeed',
  });
  await markAttemptInitiated(database.db, {
    attemptId,
    provider: 'mock',
    providerReference,
  });
  assert.deepEqual(
    await runScenario({
      plan: planScenario('succeed', {
        reference: providerReference,
        attemptId,
        amountMinor: 200000n,
        currency: 'NGN',
        feeMinor: 1500n,
      }),
      webhookUrl: `${stack.api}/v1/webhooks/mock`,
      secret: WEBHOOK_SECRET,
    }),
    [200, 200],
  );
  await ada.waitFor(/^data: \{"type":"tips.changed"\}$/);
  await ada.waitFor(/^data: \{"type":"notifications.changed"\}$/, 10_000);
  const signals = ada.frames.filter(
    (f) => f.startsWith('data: ') && !READY.test(f),
  );
  assert.ok(
    signals.indexOf('data: {"type":"tips.changed"}') <
      signals.indexOf('data: {"type":"notifications.changed"}'),
    JSON.stringify(signals),
  );
  assert.ok(
    signals.includes('data: {"type":"moments.changed"}'),
    JSON.stringify(signals),
  );
  // Only types reach the browser: no ids, amounts or names.
  for (const frame of signals)
    assert.deepEqual(Object.keys(JSON.parse(frame.slice(6))), ['type']);
  assert.deepEqual(
    tobi.frames.filter((f) => f.startsWith('data: ') && !READY.test(f)),
    [],
  );
  ada.close();
  tobi.close();
});

test('draining refuses new streams with 503 and closes open ones with a retry line', async () => {
  const { cookie } = await signIn(stack.api, nextPhone());
  const stream = await events(cookie);
  await stream.waitFor(READY);
  stack.app.get(ReadinessService).startDraining();
  const retry = await stream.waitFor(/^retry: \d+$/);
  const ms = Number(retry.slice('retry: '.length));
  assert.ok(ms >= 1000 && ms <= 10_000, `retry ${ms}`);
  await stream.ended;
  const refused = await events(cookie);
  assert.equal(refused.status, 503);
  assert.equal(refused.headers['retry-after'], '30');
  await refused.ended;
});

test('flag off and the per-address limit (their own stack)', async (t) => {
  const off = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, LIVE_UPDATES_ENABLED: 'false' },
  });
  t.after(() => off.stop());

  await t.test(
    '204 when LIVE_UPDATES_ENABLED is false, even with a session',
    async () => {
      const { cookie } = await signIn(off.api, nextPhone());
      const stream = await openEventStream(`${off.api}/v1/me/events`, {
        cookie,
        origin: WEB,
      });
      assert.equal(stream.status, 204);
      await stream.ended;
      assert.equal(stream.body, '');
    },
  );

  await t.test(
    'the 61st connect from one IP in a minute gets 429',
    async () => {
      // A fixed one-minute window: start clear of its end so all 61 land in one window.
      const intoMinute = Date.now() % 60_000;
      if (intoMinute > 50_000) await sleep(60_000 - intoMinute + 100);
      const statuses = [];
      for (let i = 0; i < 61; i += 1) {
        const stream = await openEventStream(`${off.api}/v1/me/events`, {
          origin: WEB,
        });
        statuses.push(stream.status);
        await stream.ended;
      }
      // The 204 test above counted once against this address.
      assert.equal(statuses.at(-1), 429);
      assert.ok(
        statuses.slice(0, 59).every((s) => s === 401),
        JSON.stringify(statuses),
      );
    },
  );
});
