import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  currentLiveSwitch,
  recordLiveSwitch,
} from '../../packages/database/dist/index.js';
import { LiveSwitchRecorder } from '../../apps/api/dist/health/live-switch.recorder.js';
import { opsSignIn, startStack, WEB } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const ON = { live: true, provider: 'bachs-live', version: 'aaaaaaa1' };
const OFF = { live: false, provider: 'bachs-live', version: 'bbbbbbb2' };

let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
});
after(() => database.close());
beforeEach(() => database.pool.query('DELETE FROM live_payment_switches'));

const rows = async () =>
  (
    await database.pool.query(
      'SELECT live, provider, version FROM live_payment_switches ORDER BY switched_at, id',
    )
  ).rows;

test('switching on records one row with the provider and version', async () => {
  const now = new Date('2026-11-01T09:00:00Z');
  assert.equal(await recordLiveSwitch(database.db, { ...ON, now }), 'recorded');
  assert.deepEqual(await rows(), [ON]);
  assert.deepEqual(await currentLiveSwitch(database.db), {
    ...ON,
    switchedAt: now,
  });
});

test('each recorded switch is also in the audit log, with the system as its actor', async () => {
  const count = async () =>
    (
      await database.pool.query(
        `SELECT reason, staff_user_id FROM audit_events WHERE action = 'payments.live_on' ORDER BY created_at DESC, id DESC`,
      )
    ).rows;
  const before = (await count()).length;
  await recordLiveSwitch(database.db, ON);
  await recordLiveSwitch(database.db, ON);
  const after = await count();
  assert.equal(after.length, before + 1);
  assert.equal(after[0].staff_user_id, null);
  assert.match(after[0].reason, /bachs-live/);
  assert.match(after[0].reason, /aaaaaaa1/);
  const { rows: off } = await database.pool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE action = 'payments.live_off'`,
  );
  await recordLiveSwitch(database.db, OFF);
  const { rows: offAfter } = await database.pool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE action = 'payments.live_off'`,
  );
  assert.equal(offAfter[0].n, off[0].n + 1);
});

test('a copy that has never been on records nothing: there was no switch', async () => {
  assert.equal(await recordLiveSwitch(database.db, OFF), 'unchanged');
  assert.deepEqual(await rows(), []);
  assert.equal(await currentLiveSwitch(database.db), null);
});

test('three copies booting at once record one row', async () => {
  const results = await Promise.all(
    [1, 2, 3].map(() => recordLiveSwitch(database.db, ON)),
  );
  assert.deepEqual(results.sort(), ['recorded', 'unchanged', 'unchanged']);
  assert.equal((await rows()).length, 1);
});

test('restarting without a change records nothing, even on a new version', async () => {
  await recordLiveSwitch(database.db, ON);
  assert.equal(await recordLiveSwitch(database.db, ON), 'unchanged');
  assert.equal(
    await recordLiveSwitch(database.db, { ...ON, version: 'ccccccc3' }),
    'unchanged',
  );
  assert.equal((await rows()).length, 1);
});

test('switching off records a row, and on again another', async () => {
  const first = new Date('2026-11-01T09:00:00Z');
  await recordLiveSwitch(database.db, { ...ON, now: first });
  assert.equal(
    await recordLiveSwitch(database.db, {
      ...OFF,
      now: new Date('2026-11-01T10:00:00Z'),
    }),
    'recorded',
  );
  assert.equal((await currentLiveSwitch(database.db)).live, false);
  assert.equal(
    await recordLiveSwitch(database.db, {
      ...ON,
      now: new Date('2026-11-01T11:00:00Z'),
    }),
    'recorded',
  );
  assert.deepEqual(await rows(), [ON, OFF, ON]);
  assert.equal((await currentLiveSwitch(database.db)).live, true);
});

const logger = (entries) => ({
  info: (entry) => entries.push(entry),
  error: (entry) => entries.push(entry),
});

test('API boot records the configured state and logs it, naming the version', async () => {
  const entries = [];
  const recorder = new LiveSwitchRecorder(
    {
      PAYMENTS_LIVE_ENABLED: true,
      PAYMENT_PROVIDER: 'bachs-live',
      GIT_SHA: 'ddddddd4',
    },
    { db: database.db },
    logger(entries),
  );
  await recorder.onApplicationBootstrap();
  assert.deepEqual(await rows(), [
    { live: true, provider: 'bachs-live', version: 'ddddddd4' },
  ]);
  assert.deepEqual(entries, [
    { event: 'live_switch.recorded', live: true, version: 'ddddddd4' },
  ]);
});

test('a copy with no version records unknown', async () => {
  await new LiveSwitchRecorder(
    { PAYMENTS_LIVE_ENABLED: true, PAYMENT_PROVIDER: 'bachs-live' },
    { db: database.db },
    logger([]),
  ).onApplicationBootstrap();
  assert.equal((await rows())[0].version, 'unknown');
});

test('a failed record does not stop the API starting, and is logged without its reason', async () => {
  const entries = [];
  await new LiveSwitchRecorder(
    { PAYMENTS_LIVE_ENABLED: true, PAYMENT_PROVIDER: 'bachs-live' },
    {
      db: {
        transaction: async () => {
          throw new Error('postgres://u:secret@host/db refused');
        },
      },
    },
    logger(entries),
  ).onApplicationBootstrap();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'live_switch.record_failed');
  assert.doesNotMatch(JSON.stringify(entries), /secret/);
});

test('the staff Overview shows the latest switch, and a real boot of a closed copy records nothing', async () => {
  const stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB },
  });
  try {
    assert.deepEqual(await rows(), []);
    const owner = await opsSignIn(stack.api, database.db, '+2348031110011');
    const metrics = async () =>
      (
        await (
          await fetch(`${stack.api}/v1/ops/metrics/health`, {
            headers: { cookie: owner.cookie },
          })
        ).json()
      ).data.metrics;
    const overview = async () => (await metrics()).liveSwitch;
    assert.equal(await overview(), null);
    // What this API is doing now comes from its own config, whatever the record says.
    assert.deepEqual((await metrics()).liveNow, {
      live: false,
      provider: 'mock',
      checkout: 'test',
      handles: [],
    });
    const now = new Date('2026-11-01T09:00:00Z');
    await recordLiveSwitch(database.db, { ...ON, now });
    assert.deepEqual(await overview(), {
      ...ON,
      switchedAt: now.toISOString(),
    });
    assert.equal((await metrics()).liveNow.live, false);
    // The public health route says the two disagree, for the watcher, and nothing more.
    const health = await (await fetch(`${stack.api}/health/payments`)).json();
    assert.equal(health.data.switchRecordMatches, false);
  } finally {
    await stack.stop();
  }
});
