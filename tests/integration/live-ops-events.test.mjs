import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  changeRole,
  createRole,
  ensureOwnerRole,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { liveChannel } from '../../packages/contracts/dist/index.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  browserHeaders,
  openEventStream,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// The staff stream (live updates addendum §3.1, base design §4.2 and §9): signals only, behind the
// admin grant, never counted as activity, and limited to what the grant's permissions allow. It
// resets its database in before(): on a shared database run it with --test-concurrency=1.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const REASON = 'Agreed with the owner in the weekly review';

let database;
let stack;
let redis;
let owner;
let ownerId;
let viewer;
let other;
let noIssuesRoleId;
let phone = 0;
const nextPhone = () =>
  `+2348037${String(300000 + (phone += 1)).padStart(6, '0')}`;

async function userIdOf(phoneNumber) {
  const { rows } = await database.pool.query(
    'SELECT id FROM users WHERE phone_e164 = $1',
    [phoneNumber],
  );
  return rows[0].id;
}

/** A signed-in staff member with a live grant, on a new role holding exactly `permissions`. */
async function staffWith(permissions, name) {
  const number = nextPhone();
  const person = await opsSignIn(stack.api, database.db, number);
  const userId = await userIdOf(number);
  const role = await createRole(database.db, {
    actorId: ownerId,
    name,
    description: '',
    permissions,
    reason: REASON,
  });
  await changeRole(database.db, {
    actorId: ownerId,
    userId,
    roleId: role.id,
    reason: REASON,
  });
  return { ...person, userId, roleId: role.id };
}

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ensureOwnerRole(database.db);
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      LIVE_UPDATES_ENABLED: 'true',
      LIVE_HEARTBEAT_MS: '1000',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
      // Every test here connects from 127.0.0.1; the per-address limit has its own stack below.
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
    },
  });
  redis = new Redis(REDIS_URL);
  const ownerPhone = nextPhone();
  owner = await opsSignIn(stack.api, database.db, ownerPhone);
  ownerId = await userIdOf(ownerPhone);
  viewer = await staffWith(['issues.view'], 'Issues desk');
  other = await staffWith(['analytics.view'], 'Numbers desk');
  noIssuesRoleId = other.roleId;
  // The role changes above each raise staff.changed through the relay: let them land before any
  // stream opens, so a test sees only the signals it caused.
  await sleep(2000);
});
after(async () => {
  // A failed test can leave its stream open, and an open stream holds app.close() forever.
  for (const stream of opened) stream.close();
  await redis?.quit();
  await stack?.stop();
  await database?.close();
});

const opened = new Set();
const track = async (pending) => {
  const stream = await pending;
  opened.add(stream);
  return stream;
};
const opsEvents = (cookie, api = stack.api) =>
  track(
    openEventStream(`${api}/v1/ops/events`, {
      ...(cookie ? { cookie } : {}),
      origin: WEB,
    }),
  );
const READY = /^data: \{"type":"ready"\}$/;
const ENDED = /^data: \{"type":"session.ended"\}$/;
const ISSUES = 'data: {"type":"ops.issues.changed"}';
const publish = (message) =>
  redis.publish(liveChannel(stack.prefix), JSON.stringify(message));
const lastSeenOf = async (userId) =>
  (
    await database.pool.query(
      `SELECT last_seen_at::text AS at FROM ops_sessions
       WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [userId],
    )
  ).rows[0].at;
/** The error body without its per-request reference. */
const errorOf = (text) => {
  const { error } = JSON.parse(text);
  delete error.reference;
  return error;
};
const signals = (stream) =>
  stream.frames.filter((f) => f.startsWith('data: ') && !READY.test(f));

test('no grant is 404 and a recipient session alone is 404', async () => {
  const issues = async (cookie) => {
    const response = await fetch(`${stack.api}/v1/ops/issues`, {
      headers: cookie ? { cookie } : {},
    });
    return { status: response.status, error: errorOf(await response.text()) };
  };
  const recipient = await signIn(stack.api, nextPhone());
  // No cookie at all, a recipient's session, and staff whose session has no admin grant cookie.
  for (const cookie of [
    undefined,
    recipient.cookie,
    owner.sessionCookie,
    `${owner.sessionCookie}; tipme_ops=${'x'.repeat(43)}`,
  ]) {
    const stream = await opsEvents(cookie);
    await stream.ended;
    assert.equal(stream.status, 404, String(cookie));
    const expected = await issues(cookie);
    assert.equal(expected.status, 404);
    assert.deepEqual(errorOf(stream.body), expected.error);
  }
});

test('GET /v1/ops/me says liveUpdates', async () => {
  const response = await fetch(`${stack.api}/v1/ops/me`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.state, 'granted');
  assert.equal(data.liveUpdates, true);
});

test('with live updates off the route answers 204', async (t) => {
  const off = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, LIVE_UPDATES_ENABLED: 'false' },
  });
  t.after(() => off.stop());
  // Granted or not: the gate answers first, so nothing is learnt and nothing is counted.
  for (const cookie of [owner.cookie, undefined]) {
    const stream = await opsEvents(cookie, off.api);
    assert.equal(stream.status, 204);
    await stream.ended;
    assert.equal(stream.body, '');
  }
  const me = await fetch(`${off.api}/v1/ops/me`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal((await me.json()).data.liveUpdates, false);
});

test(
  'a granted staff member gets retry, ready, then heartbeats past 12 s',
  { timeout: 30_000 },
  async () => {
    const stream = await opsEvents(owner.cookie);
    assert.equal(stream.status, 200);
    assert.equal(
      stream.headers['content-type'],
      'text/event-stream; charset=utf-8',
    );
    assert.equal(stream.headers['access-control-allow-origin'], WEB);
    await stream.waitFor(READY);
    let ended = false;
    void stream.ended.then(() => (ended = true));
    await sleep(12_500);
    assert.equal(ended, false, 'the stream must outlive the request timeout');
    assert.deepEqual(stream.frames.slice(0, 2), [
      'retry: 5000',
      'data: {"type":"ready"}',
    ]);
    assert.ok(
      stream.frames.filter((f) => f === ': hb\nevent: hb\ndata: {}').length >=
        10,
      'a heartbeat every second',
    );
    stream.close();
  },
);

test("connecting does not move the grant's lastSeenAt", async () => {
  const before = await lastSeenOf(ownerId);
  const stream = await opsEvents(owner.cookie);
  await stream.waitFor(READY);
  await sleep(2000);
  assert.equal(await lastSeenOf(ownerId), before);
  stream.close();
  // An ordinary admin read still counts as activity.
  await fetch(`${stack.api}/v1/ops/issues`, {
    headers: { cookie: owner.cookie },
  });
  assert.notEqual(await lastSeenOf(ownerId), before);
});

// Final review I1 (ruling L-R22): the reads a stream starts (its ready, a reconnect's resync, a
// signal) carry the background header and are not activity either, so an open, visible but idle
// tab still loses its grant after the idle hour. The person's own reads and actions still count.
test("a reconnect's resync read (background) does not move lastSeenAt; an unmarked read does", async () => {
  await database.pool.query(
    `UPDATE ops_sessions SET last_seen_at = now() - interval '10 minutes'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [ownerId],
  );
  const before = await lastSeenOf(ownerId);
  const stream = await opsEvents(owner.cookie);
  await stream.waitFor(READY);
  // What the client's ready resync runs: the menu's count and the page's own list.
  for (const path of ['/v1/ops/approvals?status=pending', '/v1/ops/issues']) {
    const response = await fetch(`${stack.api}${path}`, {
      headers: {
        cookie: owner.cookie,
        origin: WEB,
        'x-tipme-background': '1',
      },
    });
    assert.equal(response.status, 200, path);
  }
  stream.close();
  assert.equal(await lastSeenOf(ownerId), before);
  // The browser sends it cross-origin, so the preflight must allow it.
  const preflight = await fetch(`${stack.api}/v1/ops/issues`, {
    method: 'OPTIONS',
    headers: {
      origin: WEB,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-tipme-background',
    },
  });
  assert.match(
    preflight.headers.get('access-control-allow-headers') ?? '',
    /x-tipme-background/,
  );
  const unmarked = await fetch(`${stack.api}/v1/ops/issues`, {
    headers: { cookie: owner.cookie, origin: WEB },
  });
  assert.equal(unmarked.status, 200);
  assert.notEqual(await lastSeenOf(ownerId), before);
});

test("the stream closes at the grant's idle deadline", async (t) => {
  await database.pool.query(
    `UPDATE ops_sessions SET last_seen_at = now() - interval '60 minutes' + interval '3 seconds'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [ownerId],
  );
  t.after(() =>
    database.pool.query(
      `UPDATE ops_sessions SET last_seen_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [ownerId],
    ),
  );
  const started = Date.now();
  const stream = await opsEvents(owner.cookie);
  assert.equal(stream.status, 200);
  await stream.waitFor(READY);
  await Promise.race([
    stream.ended,
    sleep(6000).then(() => assert.fail('the stream outlived its grant')),
  ]);
  assert.ok(Date.now() - started < 6000);
});

test('an issues signal reaches only staff holding issues.view', async () => {
  const recipient = await signIn(stack.api, nextPhone());
  const seeing = await opsEvents(viewer.cookie);
  const blind = await opsEvents(other.cookie);
  const me = await track(
    openEventStream(`${stack.api}/v1/me/events`, {
      cookie: recipient.cookie,
      origin: WEB,
    }),
  );
  for (const s of [seeing, blind, me]) await s.waitFor(READY);
  await publish({ to: { staff: 'issues.view' }, type: 'ops.issues.changed' });
  assert.equal(await seeing.waitFor(/ops\.issues\.changed/), ISSUES);
  await sleep(500);
  assert.deepEqual(signals(blind), []);
  assert.deepEqual(signals(me), []);
  // A list target: any one permission is enough.
  await publish({
    to: { staff: ['issues.view', 'providers.manage'] },
    type: 'ops.providers.changed',
  });
  await seeing.waitFor(/ops\.providers\.changed/);
  await sleep(500);
  assert.deepEqual(signals(blind), []);
  for (const s of [seeing, blind, me]) s.close();
});

test('losing issues.view mid-stream closes the stream with session.ended', async () => {
  const stream = await opsEvents(viewer.cookie);
  const kept = await opsEvents(owner.cookie);
  await stream.waitFor(READY);
  await kept.waitFor(READY);
  // The role change is a sensitive route: the owner's code counts as just entered.
  await database.pool.query(
    `UPDATE ops_sessions SET last_totp_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [ownerId],
  );
  const change = await fetch(
    `${stack.api}/v1/ops/staff/${viewer.userId}/role`,
    {
      method: 'PUT',
      headers: browserHeaders(owner.cookie),
      body: JSON.stringify({ roleId: noIssuesRoleId, reason: REASON }),
    },
  );
  assert.equal(change.status, 200, await change.clone().text());
  // The relay turns ops.staff_changed into staff.changed; the stream's set no longer matches.
  await stream.waitFor(ENDED, 10_000);
  await stream.ended;
  // The owner's permissions did not change: their stream stays.
  await sleep(500);
  assert.equal(
    kept.frames.some((f) => ENDED.test(f)),
    false,
  );
  // Reconnected with the new set, issues signals no longer arrive.
  const again = await opsEvents(viewer.cookie);
  assert.equal(again.status, 200);
  await again.waitFor(READY);
  await publish({ to: { staff: 'issues.view' }, type: 'ops.issues.changed' });
  await kept.waitFor(/ops\.issues\.changed/);
  await sleep(500);
  assert.deepEqual(signals(again), []);
  again.close();
  kept.close();
});

test("resetting a staff member's authenticator closes their stream", async () => {
  const lost = await staffWith(['issues.view'], 'Lost phone desk');
  await database.pool.query(
    `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
    [lost.userId, `lost-${lost.userId.slice(0, 8)}@example.com`],
  );
  // Let the role change's own staff.changed land first.
  await sleep(2000);
  const stream = await opsEvents(lost.cookie);
  await stream.waitFor(READY);
  await database.pool.query(
    `UPDATE ops_sessions SET last_totp_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [ownerId],
  );
  const reset = await fetch(
    `${stack.api}/v1/ops/staff/${lost.userId}/reset-authenticator`,
    {
      method: 'POST',
      headers: browserHeaders(owner.cookie),
      body: JSON.stringify({ reason: REASON }),
    },
  );
  assert.equal(reset.status, 200, await reset.clone().text());
  await stream.waitFor(ENDED, 10_000);
  await stream.ended;
});

test('admin sign-out closes the staff stream', async () => {
  const stream = await opsEvents(other.cookie);
  await stream.waitFor(READY);
  const out = await fetch(`${stack.api}/v1/ops/sign-out`, {
    method: 'POST',
    headers: browserHeaders(other.cookie),
  });
  assert.equal(out.status, 204);
  await stream.waitFor(ENDED, 5000);
  await stream.ended;
  const refused = await opsEvents(other.cookie);
  await refused.ended;
  assert.equal(refused.status, 404);
});

test('the 61st connect from one address in a minute gets 429 before the grant check (its own stack, the default limit)', async (t) => {
  const limited = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, LIVE_UPDATES_ENABLED: 'true' },
  });
  t.after(() => limited.stop());
  // A fixed one-minute window: start clear of its end so all 61 land in one window.
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 50_000) await sleep(60_000 - intoMinute + 100);
  const statuses = [];
  for (let i = 0; i < 61; i += 1) {
    const stream = await opsEvents(undefined, limited.api);
    statuses.push(stream.status);
    await stream.ended;
  }
  assert.ok(
    statuses.slice(0, 60).every((s) => s === 404),
    JSON.stringify(statuses),
  );
  assert.equal(statuses.at(-1), 429, 'the address limit runs before OpsGuard');
});
