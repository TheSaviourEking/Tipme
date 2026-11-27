import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { liveChannel } from '../../packages/contracts/dist/index.js';
import { createStatusToken } from '../../apps/api/dist/checkout/status-token.js';
import { LiveHubService } from '../../apps/api/dist/live/live-hub.service.js';
import {
  REDIS_URL,
  Redis,
  STATUS_TOKEN_SECRET,
  WEBHOOK_SECRET,
  WEB,
  openEventStream,
  startStack,
} from './helpers.mjs';

// It resets its database (and reseeds) in before(): on a shared database, such as an e2e lane's,
// run integration files one at a time (--test-concurrency=1).
// A tip's receipt stream (addendum §3.6): the status token in the Authorization header, the status
// route's 404 for anything else, and nothing on it but "this tip changed".
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let redis;
let mock;

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
      // Every test here connects from 127.0.0.1; the per-address limit is the recipient file's.
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
    },
  });
  redis = new Redis(REDIS_URL);
  mock = createMockProvider({
    redis,
    secret: WEBHOOK_SECRET,
    prefix: stack.prefix,
  });
});
after(async () => {
  await redis?.quit();
  await stack?.stop();
  await database?.close();
});

const READY = /^data: \{"type":"ready"\}$/;
const TIP_CHANGED = /^data: \{"type":"tip.changed"\}$/;
const bearer = (token) => (token ? { authorization: `Bearer ${token}` } : {});
const tipEvents = (api, tipId, token) =>
  openEventStream(`${api}/v1/tips/${tipId}/events`, {
    ...bearer(token),
    origin: WEB,
  });
const tipStatus = (api, tipId, token) =>
  fetch(`${api}/v1/tips/${tipId}/status`, {
    headers: { ...bearer(token), origin: WEB },
  });
const signals = (stream) =>
  stream.frames.filter((f) => f.startsWith('data: ') && !READY.test(f));

/** A pretend tip to `handle`, started with the mock and not yet paid: its receipt says waiting. */
async function pendingTip(handle = 'ada') {
  const { quoteId } = await createQuote(database.db, {
    handle,
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(database.db, {
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
  return {
    tipId,
    attemptId,
    providerReference,
    token: createStatusToken(STATUS_TOKEN_SECRET, tipId),
  };
}

async function pay(tip, api = stack.api) {
  assert.deepEqual(
    await runScenario({
      plan: planScenario('succeed', {
        reference: tip.providerReference,
        attemptId: tip.attemptId,
        amountMinor: 200000n,
        currency: 'NGN',
        feeMinor: 1500n,
      }),
      webhookUrl: `${api}/v1/webhooks/mock`,
      secret: WEBHOOK_SECRET,
    }),
    [200, 200],
  );
}

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

/** An error body without its per-request reference. */
const withoutReference = (text) => {
  const body = JSON.parse(text);
  delete body.error?.reference;
  return body;
};

test('no token, a wrong token, tip B’s token and a malformed id are all the status route’s 404', async () => {
  const a = await pendingTip();
  const b = await pendingTip();
  const unknown = randomUUID();
  const cases = [
    ['no token', a.tipId, undefined],
    ['a wrong token', a.tipId, 'x'.repeat(43)],
    ['tip B’s token', a.tipId, b.token],
    ['a malformed header', a.tipId, `${a.token}!`],
    [
      'a malformed id',
      'not-a-uuid',
      createStatusToken(STATUS_TOKEN_SECRET, 'not-a-uuid'),
    ],
    // A valid token for a tip that does not exist (ruling L-R5): the same 404, no lookup oracle.
    [
      'an unknown tip',
      unknown,
      createStatusToken(STATUS_TOKEN_SECRET, unknown),
    ],
  ];
  for (const [name, tipId, token] of cases) {
    const status = await tipStatus(stack.api, tipId, token);
    const stream = await tipEvents(stack.api, tipId, token);
    await stream.ended;
    assert.equal(status.status, 404, name);
    assert.equal(stream.status, 404, name);
    assert.deepEqual(
      withoutReference(stream.body),
      withoutReference(await status.text()),
      name,
    );
    assert.equal(
      stream.headers['content-type'],
      status.headers.get('content-type'),
      name,
    );
    assert.equal(
      stream.headers['cache-control'],
      status.headers.get('cache-control'),
      name,
    );
  }
  // None of them touched tip A's own allowance: its receipt still connects.
  const ok = await tipEvents(stack.api, a.tipId, a.token);
  assert.equal(ok.status, 200);
  ok.close();
});

test('a pending tip’s stream gets ready, then tip.changed when it is paid', async () => {
  const tip = await pendingTip('ada');
  const other = await pendingTip('ada');
  const receipt = await tipEvents(stack.api, tip.tipId, tip.token);
  const otherReceipt = await tipEvents(stack.api, other.tipId, other.token);
  const recipient = await openEventStream(`${stack.api}/v1/me/events`, {
    cookie: await ownerCookie('ada'),
    origin: WEB,
  });
  assert.equal(receipt.status, 200);
  assert.equal(
    receipt.headers['content-type'],
    'text/event-stream; charset=utf-8',
  );
  assert.equal(receipt.headers['cache-control'], 'no-store, no-transform');
  // A public route: the web app's origin, and never credentials.
  assert.equal(receipt.headers['access-control-allow-origin'], WEB);
  assert.equal(receipt.headers['access-control-allow-credentials'], undefined);
  await receipt.waitFor(READY);
  await otherReceipt.waitFor(READY);
  await recipient.waitFor(READY);
  // A broadcast and a signal for the recipient, published while the receipt is open: neither
  // may reach it.
  await redis.publish(
    liveChannel(stack.prefix),
    JSON.stringify({ to: { all: true }, type: 'withdrawals.changed' }),
  );
  await recipient.waitFor(/^data: \{"type":"withdrawals.changed"\}$/);
  const paidAt = Date.now();
  await pay(tip);
  await receipt.waitFor(TIP_CHANGED, 5000);
  assert.ok(Date.now() - paidAt < 5000);
  await recipient.waitFor(/^data: \{"type":"tips.changed"\}$/, 10_000);
  // Let the relay's notifications and moments signals pass too.
  await recipient.waitFor(/^data: \{"type":"notifications.changed"\}$/, 10_000);
  await sleep(500);
  assert.ok(signals(receipt).length >= 1, JSON.stringify(receipt.frames));
  for (const frame of signals(receipt))
    assert.match(frame, TIP_CHANGED, JSON.stringify(receipt.frames));
  // Tip B's receipt heard nothing of tip A, and the recipient never hears tip.changed.
  assert.deepEqual(signals(otherReceipt), []);
  assert.ok(!recipient.frames.some((f) => TIP_CHANGED.test(f)));
  for (const s of [receipt, otherReceipt, recipient]) s.close();
});

test('a final tip’s stream is 204', async () => {
  const tip = await pendingTip();
  await pay(tip);
  // The relay books it; the status route says paid once it has.
  for (let i = 0; i < 50; i += 1) {
    const view = await (
      await tipStatus(stack.api, tip.tipId, tip.token)
    ).json();
    if (view.data.state === 'paid') break;
    await sleep(100);
  }
  const stream = await tipEvents(stack.api, tip.tipId, tip.token);
  assert.equal(stream.status, 204);
  await stream.ended;
  assert.equal(stream.body, '');
});

test('a fourth open stream for one tip gets 429 LIVE_LIMIT, and closing one frees its place', async () => {
  const tip = await pendingTip();
  const open = [];
  for (let i = 0; i < 3; i += 1) {
    const stream = await tipEvents(stack.api, tip.tipId, tip.token);
    assert.equal(stream.status, 200);
    await stream.waitFor(READY);
    open.push(stream);
  }
  const fourth = await tipEvents(stack.api, tip.tipId, tip.token);
  await fourth.ended;
  assert.equal(fourth.status, 429);
  assert.equal(JSON.parse(fourth.body).error.code, 'LIVE_LIMIT');
  open.pop().close();
  await sleep(200);
  const again = await tipEvents(stack.api, tip.tipId, tip.token);
  assert.equal(again.status, 200);
  again.close();
  for (const s of open) s.close();
});

test('the eleventh connect for one tip within the window is 429, and its Redis key has a TTL', async () => {
  const WINDOW = 900_000;
  // A fixed 15-minute window: start clear of its end so all eleven land in one window.
  const left = WINDOW - (Date.now() % WINDOW);
  if (left < 30_000) await sleep(left + 100);
  const tip = await pendingTip();
  const hub = stack.app.get(LiveHubService);
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    const before = hub.counts().tip;
    const stream = await tipEvents(stack.api, tip.tipId, tip.token);
    statuses.push(stream.status);
    if (stream.status === 200) {
      await stream.waitFor(READY);
      stream.close();
      // Wait for the copy to let it go, so the three-per-tip limit never answers first.
      for (let w = 0; w < 50 && hub.counts().tip > before; w += 1)
        await sleep(20);
    }
    await stream.ended;
  }
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  const key = `rl:${stack.prefix}:tip_live_connect:tip:${tip.tipId}:${Math.floor(Date.now() / WINDOW)}`;
  assert.equal(await redis.get(key), '11');
  const ttl = await redis.ttl(key);
  assert.ok(ttl > 0 && ttl <= 900, `ttl ${ttl}`);
  // Another tip has its own allowance.
  const other = await pendingTip();
  const fresh = await tipEvents(stack.api, other.tipId, other.token);
  assert.equal(fresh.status, 200);
  fresh.close();
});

test('tip.changed is the only signal type a tip stream can ever receive', async () => {
  const tip = await pendingTip('ada');
  const receipt = await tipEvents(stack.api, tip.tipId, tip.token);
  await receipt.waitFor(READY);
  const channel = liveChannel(stack.prefix);
  const { rows } = await database.pool.query(
    "SELECT id, user_id FROM profiles WHERE handle = 'ada'",
  );
  // Every target a publisher could name, with every kind of type, and a forged pairing of a tip
  // target with a recipient type (the contracts refuse it: ruling L-R4).
  const messages = [
    { to: { all: true }, type: 'withdrawals.changed' },
    { to: { profile: rows[0].id }, type: 'tips.changed' },
    { to: { user: rows[0].user_id }, type: 'notifications.changed' },
    { to: { staff: 'any' }, type: 'ops.approvals.changed' },
    { to: { tip: tip.tipId }, type: 'tips.changed' },
    { to: { tip: tip.tipId }, type: 'ops.issues.changed' },
    { to: { tip: tip.tipId }, type: 'tip.changed' },
  ];
  for (const message of messages)
    await redis.publish(channel, JSON.stringify(message));
  await receipt.waitFor(TIP_CHANGED);
  await pay(tip);
  await sleep(1500);
  const allowed = new Set([
    'ready',
    'resync',
    'poll',
    'session.ended',
    'tip.changed',
  ]);
  const data = receipt.frames.filter((f) => f.startsWith('data: '));
  for (const frame of data) {
    const body = JSON.parse(frame.slice('data: '.length));
    assert.deepEqual(Object.keys(body), ['type'], frame);
    assert.ok(allowed.has(body.type), frame);
  }
  // Heartbeats are the only other frames.
  for (const frame of receipt.frames.filter((f) => !f.startsWith('data: ')))
    assert.ok(
      frame === 'retry: 5000' || frame === ': hb\nevent: hb\ndata: {}',
      frame,
    );
  receipt.close();
});

test('a stream ends at its lifetime (its own stack)', async (t) => {
  const short = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      LIVE_UPDATES_ENABLED: 'true',
      LIVE_HEARTBEAT_MS: '1000',
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
      LIVE_TIP_LIFETIME_MS: '3000',
    },
  });
  t.after(() => short.stop());
  const tip = await pendingTip();
  const started = Date.now();
  const stream = await tipEvents(short.api, tip.tipId, tip.token);
  assert.equal(stream.status, 200);
  await stream.waitFor(READY);
  await Promise.race([
    stream.ended,
    sleep(5000).then(() => assert.fail('the stream outlived its lifetime')),
  ]);
  const lasted = Date.now() - started;
  assert.ok(lasted >= 2500 && lasted < 5000, `lasted ${lasted} ms`);
  assert.equal(short.app.get(LiveHubService).counts().tip, 0);
});

test('with live off, the status view says live false and the events route answers 204 (its own stack)', async (t) => {
  // With live on, the status view says so.
  const on = await pendingTip();
  const view = await (await tipStatus(stack.api, on.tipId, on.token)).json();
  assert.equal(view.data.live, true);

  const off = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, LIVE_UPDATES_ENABLED: 'false' },
  });
  t.after(() => off.stop());
  const tip = await pendingTip();
  const status = await tipStatus(off.api, tip.tipId, tip.token);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).data.live, false);
  // 204 before anything else, a token or not (ruling L-R5): it reveals only that live is off.
  for (const token of [tip.token, undefined, 'wrong']) {
    const stream = await tipEvents(off.api, tip.tipId, token);
    assert.equal(stream.status, 204);
    await stream.ended;
    assert.equal(stream.body, '');
  }
});
