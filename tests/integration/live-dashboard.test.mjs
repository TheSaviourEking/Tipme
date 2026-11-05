import assert from 'node:assert/strict';
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
  WEB,
  browserHeaders,
  openEventStream,
  opsSignIn,
  startStack,
} from './helpers.mjs';

// Live updates, PR 2 (plan Tasks 13-15): plan, suspension, page edits, withdrawals, the TipMe-wide
// switch, freezes and account settings each signal the right open dashboards, and only those.
// It resets its database in before(): on a shared database run it alone (--test-concurrency=1).
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let staff;
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
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
  staff = await opsSignIn(stack.api, database.db, '+2348031270099');
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const READY = /^data: \{"type":"ready"\}$/;
const frame = (type) => new RegExp(`^data: \\{"type":"${type}"\\}$`);
const signals = (stream) =>
  stream.frames.filter((f) => f.startsWith('data: ') && !READY.test(f));

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
async function streamOf(t, cookie) {
  const stream = await openEventStream(`${stack.api}/v1/me/events`, {
    cookie,
    origin: WEB,
  });
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  await stream.waitFor(READY);
  return stream;
}

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Nothing of `type` arrived on `stream` within `ms` (a signal for someone else). */
async function quiet(stream, type, ms = 1500) {
  await sleep(ms);
  assert.ok(
    !stream.frames.some((f) => frame(type).test(f)),
    JSON.stringify(signals(stream)),
  );
}

test('staff setting Pro publishes profile.changed to that user only', async (t) => {
  const ada = await owner('ada');
  const tobi = await owner('tobi');
  const adaStream = await streamOf(t, ada.cookie);
  const tobiStream = await streamOf(t, tobi.cookie);
  const set = await call(
    'POST',
    `/v1/ops/pages/${ada.profileId}/plan`,
    staff.cookie,
    { plan: 'pro', reason: 'Pilot recipient for live updates' },
  );
  assert.equal(set.status, 200);
  await adaStream.waitFor(frame('profile.changed'));
  await quiet(tobiStream, 'profile.changed');
  // Only the type reaches the browser.
  for (const f of signals(adaStream))
    assert.deepEqual(Object.keys(JSON.parse(f.slice(6))), ['type']);
  adaStream.close();
  tobiStream.close();
  await call('POST', `/v1/ops/pages/${ada.profileId}/plan`, staff.cookie, {
    plan: 'free',
    reason: 'Back to Free after the live test',
  });
});

test('suspending a page publishes profile.changed, and so does lifting it', async (t) => {
  const tobi = await owner('tobi');
  const stream = await streamOf(t, tobi.cookie);
  const reason = 'Checking a report about this page';
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/pages/${tobi.profileId}/suspend`,
        staff.cookie,
        { reason },
      )
    ).status,
    200,
  );
  await stream.waitFor(frame('profile.changed'));
  const before = signals(stream).length;
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/pages/${tobi.profileId}/unsuspend`,
        staff.cookie,
        { reason },
      )
    ).status,
    200,
  );
  for (let i = 0; i < 50 && signals(stream).length === before; i += 1)
    await sleep(100);
  assert.ok(signals(stream).length > before, 'lifting it signals too');
  stream.close();
});

test('an edit from one device reaches the same person’s other open tabs', async (t) => {
  const ada = await owner('ada');
  const stream = await streamOf(t, ada.cookie);
  const other = await owner('ada');
  const edited = await call('PATCH', '/v1/me/profile', other.cookie, {
    displayName: 'Ada Live',
  });
  assert.equal(edited.status, 200);
  await stream.waitFor(frame('profile.changed'));
  stream.close();
});

test('the withdrawals switch reaches every recipient stream', async (t) => {
  const ada = await streamOf(t, (await owner('ada')).cookie);
  const tobi = await streamOf(t, (await owner('tobi')).cookie);
  const set = (paused) =>
    call('POST', '/v1/ops/withdrawals-switch', staff.cookie, {
      paused,
      reason: 'Live updates test: stopping for a moment.',
    });
  assert.equal((await set(true)).status, 200);
  try {
    // From the relay, after the switch's commit.
    await ada.waitFor(frame('withdrawals.changed'), 10_000);
    await tobi.waitFor(frame('withdrawals.changed'), 10_000);
  } finally {
    assert.equal((await set(false)).status, 200);
  }
  // Switching back on broadcasts too: wait for it here, so it can't land in the next test.
  const count = () =>
    ada.frames.filter((f) => frame('withdrawals.changed').test(f)).length;
  for (let i = 0; i < 100 && count() < 2; i += 1) await sleep(100);
  assert.equal(count(), 2, 'off and on each broadcast once');
  ada.close();
  tobi.close();
});

test('a freeze reaches only that page’s owner', async (t) => {
  const ada = await owner('ada');
  const tobi = await owner('tobi');
  const adaStream = await streamOf(t, ada.cookie);
  const tobiStream = await streamOf(t, tobi.cookie);
  const frozen = await call(
    'POST',
    `/v1/ops/pages/${tobi.profileId}/withdrawal-freeze`,
    staff.cookie,
    { reason: 'A reported account takeover, checking it.' },
  );
  assert.equal(frozen.status, 200);
  await tobiStream.waitFor(frame('withdrawals.changed'), 10_000);
  await quiet(adaStream, 'withdrawals.changed');
  adaStream.close();
  tobiStream.close();
});

test('saving preferences publishes account.changed to the user', async (t) => {
  const ada = await owner('ada');
  const stream = await streamOf(t, ada.cookie);
  const current = await (
    await call('GET', '/v1/me/notification-preferences', ada.cookie)
  ).json();
  const saved = await call(
    'PUT',
    '/v1/me/notification-preferences',
    ada.cookie,
    {
      ...current.data,
      hideTipDetailsInPopups: true,
    },
  );
  assert.equal(saved.status, 200, await saved.clone().text());
  await stream.waitFor(frame('account.changed'));
  stream.close();
});

test('a local quote answers from TipMe’s records alone', async (t) => {
  const ada = await owner('ada');
  const local = await call(
    'GET',
    '/v1/me/withdrawal-quote?scope=local',
    ada.cookie,
  );
  assert.equal(local.status, 200);
  const { data } = await local.json();
  // The pretend provider needs no setup: TipMe's side allows it, and the partner was not asked.
  assert.deepEqual(data, { state: 'unchecked', inReview: false });
  assert.equal(
    (await call('GET', '/v1/me/withdrawal-quote?scope=all', ada.cookie)).status,
    400,
  );
});
