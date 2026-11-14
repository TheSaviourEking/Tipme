import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  FEATURE_SWITCH_CACHE_MS,
  featureOn,
  featureSwitchOverview,
  invalidateFeatureSwitches,
  onFeatureSwitchReadError,
  resetFeatureSwitchMemory,
  readFeatureSwitch,
  seedFeatureSwitches,
  setFeatureSwitch,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Feature switches (owner, 14 Nov 2026): stored in admin, seeded once from the old variables.

const STAFF = DEMO_PROFILES[0].userId;
const SECOND = DEMO_PROFILES[1].userId;

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  // A process's seeds and last reads from an earlier test must not leak into this one.
  resetFeatureSwitchMemory();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

test('with no row and no variable, each switch reads its code default (money ones off)', async (t) => {
  const { db } = await fresh(t);
  assert.equal(await featureOn(db, 'pro_billing'), false);
  assert.equal(await featureOn(db, 'pro_auto_renew'), false);
  assert.equal(await featureOn(db, 'business'), false);
  assert.equal(await featureOn(db, 'analytics'), true);
  assert.equal(await featureOn(db, 'supporter_recognition'), true);
  assert.equal(await featureOn(db, 'page_studio'), false);
});

test('the first start writes every switch: from the old variable if set, else the default', async (t) => {
  const { db, rows } = await fresh(t);
  const result = await seedFeatureSwitches(db, {
    PRO_BILLING_ENABLED: 'true',
    ADULT_PLATFORM_LINKS: 'off',
    BUSINESS_ENABLED: '',
  });
  assert.deepEqual(result.ignored, []);
  const stored = Object.fromEntries(
    (
      await rows('SELECT key, enabled, source, reason FROM feature_switches')
    ).map((r) => [r.key, r]),
  );
  assert.equal(Object.keys(stored).length, 12);
  assert.equal(stored.pro_billing.enabled, true);
  assert.equal(stored.pro_billing.source, 'env');
  assert.match(stored.pro_billing.reason, /PRO_BILLING_ENABLED/);
  assert.equal(stored.adult_platform_links.enabled, false);
  assert.equal(stored.adult_platform_links.source, 'env');
  // Blank is unset, as in the .env files.
  assert.equal(stored.business.enabled, false);
  assert.equal(stored.business.source, 'default');
  assert.equal(stored.analytics.enabled, true);
  assert.equal(stored.analytics.source, 'default');
  invalidateFeatureSwitches();
  assert.equal(await featureOn(db, 'pro_billing'), true);
  assert.equal(await featureOn(db, 'adult_platform_links'), false);
  const [{ n }] = await rows(
    'SELECT count(*)::int AS n FROM feature_switch_changes',
  );
  assert.equal(n, 12);
});

test('after the first start the stored value wins; a variable still set is ignored and named', async (t) => {
  const { db, rows } = await fresh(t);
  await seedFeatureSwitches(db, { PRO_BILLING_ENABLED: 'true' });
  const again = await seedFeatureSwitches(db, {
    PRO_BILLING_ENABLED: 'false',
    SUPPORTER_RECOGNITION: 'off',
  });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.ignored.sort(), [
    'PRO_BILLING_ENABLED',
    'SUPPORTER_RECOGNITION',
  ]);
  invalidateFeatureSwitches();
  assert.equal(await featureOn(db, 'pro_billing'), true);
  assert.equal(await featureOn(db, 'supporter_recognition'), true);
  const [{ n }] = await rows(
    'SELECT count(*)::int AS n FROM feature_switch_changes',
  );
  assert.equal(n, 12, 'a later start writes no history');
});

test('a malformed old variable stops the first start, naming it', async (t) => {
  const { db } = await fresh(t);
  await assert.rejects(
    seedFeatureSwitches(db, { PRO_REFUNDS: 'true' }),
    /PRO_REFUNDS must be on or off/,
  );
});

test('two processes starting at once write each switch once', async (t) => {
  const { db, rows } = await fresh(t);
  await Promise.all([
    seedFeatureSwitches(db, { BUSINESS_ENABLED: 'true' }),
    seedFeatureSwitches(db, { BUSINESS_ENABLED: 'true' }),
    seedFeatureSwitches(db, { BUSINESS_ENABLED: 'true' }),
  ]);
  const [{ n }] = await rows(
    'SELECT count(*)::int AS n FROM feature_switch_changes',
  );
  assert.equal(n, 12);
});

test('reads are cached for under 30 seconds, and a change clears the cache', async (t) => {
  const { db, pool } = await fresh(t);
  assert.ok(FEATURE_SWITCH_CACHE_MS > 0 && FEATURE_SWITCH_CACHE_MS < 30_000);
  await seedFeatureSwitches(db, {});
  invalidateFeatureSwitches();
  const start = Date.now();
  assert.equal(await featureOn(db, 'business', { now: start }), false);
  // Written behind the cache's back: not seen until it expires or is cleared.
  await pool.query(
    `UPDATE feature_switches SET enabled = true WHERE key = 'business'`,
  );
  assert.equal(await featureOn(db, 'business', { now: start + 1000 }), false);
  assert.equal(
    await featureOn(db, 'business', {
      now: start + FEATURE_SWITCH_CACHE_MS + 1,
    }),
    true,
  );
  await pool.query(
    `UPDATE feature_switches SET enabled = false WHERE key = 'business'`,
  );
  const later = start + FEATURE_SWITCH_CACHE_MS + 2;
  assert.equal(await featureOn(db, 'business', { now: later }), true);
  invalidateFeatureSwitches();
  assert.equal(await featureOn(db, 'business', { now: later }), false);
});

test('a failed read keeps the last known value; with none, the code default', async (t) => {
  const { db } = await fresh(t);
  await seedFeatureSwitches(db, {
    PRO_BILLING_ENABLED: 'true',
    ANALYTICS_ENABLED: 'false',
  });
  invalidateFeatureSwitches();
  assert.equal(await featureOn(db, 'pro_billing'), true);
  const failures = [];
  const stop = onFeatureSwitchReadError((error) => failures.push(error));
  t.after(stop);
  const broken = {
    select() {
      throw new Error('connection refused');
    },
  };
  // The same process, its database gone: it keeps what it knew (a fake handle has none).
  invalidateFeatureSwitches();
  assert.equal(
    await featureOn(broken, 'pro_billing'),
    false,
    'never known: default',
  );
  assert.equal(
    await featureOn(broken, 'analytics'),
    true,
    'never known: default',
  );
  assert.equal(failures.length, 1, 'one failed read, shared by both');

  // Now a handle that read once, then failed.
  let fail = false;
  const flaky = {
    select: (...args) => {
      if (fail) throw new Error('connection refused');
      return db.select(...args);
    },
  };
  invalidateFeatureSwitches();
  assert.equal(await featureOn(flaky, 'pro_billing'), true);
  assert.equal(await featureOn(flaky, 'analytics'), false);
  fail = true;
  invalidateFeatureSwitches();
  assert.equal(await featureOn(flaky, 'pro_billing'), true, 'last known');
  assert.equal(await featureOn(flaky, 'analytics'), false, 'last known');
  assert.ok(failures.length >= 2);
});

test('a missing row (before the first start writes it) reads as this process’s variable', async (t) => {
  const { db, pool } = await fresh(t);
  await seedFeatureSwitches(db, { BUSINESS_ENABLED: 'true' });
  // A test reset (TRUNCATE) leaves no rows; production always has them after the first start.
  await pool.query('DELETE FROM feature_switches');
  invalidateFeatureSwitches();
  assert.equal(await featureOn(db, 'business'), true);
  assert.equal(await featureOn(db, 'pro_billing'), false);
});

test('setting a switch stores it, keeps history and audits it, and refuses no change', async (t) => {
  const { db, rows } = await fresh(t);
  await seedFeatureSwitches(db, {});
  const now = new Date();
  const result = await db.transaction((tx) =>
    setFeatureSwitch(tx, {
      key: 'pro_billing',
      on: true,
      staffUserId: STAFF,
      approvedBy: SECOND,
      reason: 'Opening Pro billing to everyone',
      now,
    }),
  );
  assert.deepEqual(result, { key: 'pro_billing', on: true, previous: false });
  const [row] = await rows(
    `SELECT enabled, source, changed_by FROM feature_switches WHERE key = 'pro_billing'`,
  );
  assert.deepEqual(row, { enabled: true, source: 'staff', changed_by: STAFF });
  const [audit] = await rows(
    `SELECT action, permission, subject_type, subject_id, reason FROM audit_events
     WHERE action = 'feature_switch.set'`,
  );
  assert.equal(audit.permission, 'switches.manage');
  assert.equal(audit.subject_type, 'feature_switch');
  assert.equal(audit.subject_id, 'pro_billing');
  assert.match(audit.reason, /Opening Pro billing/);
  assert.equal(
    await db.transaction((tx) => readFeatureSwitch(tx, 'pro_billing')),
    true,
  );
  await assert.rejects(
    db.transaction((tx) =>
      setFeatureSwitch(tx, {
        key: 'pro_billing',
        on: true,
        staffUserId: STAFF,
        approvedBy: null,
        reason: 'Opening Pro billing again',
        now,
      }),
    ),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    db.transaction((tx) =>
      setFeatureSwitch(tx, {
        key: 'nope',
        on: true,
        staffUserId: STAFF,
        approvedBy: null,
        reason: 'An unknown switch here',
        now,
      }),
    ),
    (error) => error.code === 'INVALID_INPUT',
  );
  const overview = await featureSwitchOverview(db);
  const billing = overview.find((s) => s.key === 'pro_billing');
  assert.equal(billing.on, true);
  assert.equal(billing.money, true);
  assert.equal(billing.source, 'staff');
  assert.equal(billing.changedBy, STAFF);
  assert.equal(billing.envName, 'PRO_BILLING_ENABLED');
  assert.equal(billing.history.length, 2);
  assert.equal(billing.history[0].approvedBy, SECOND);
  assert.equal(billing.history[1].source, 'default');
  assert.equal(overview.length, 12);
});

test('history is append-only', async (t) => {
  const { db, pool } = await fresh(t);
  await seedFeatureSwitches(db, {});
  await assert.rejects(pool.query('DELETE FROM feature_switch_changes'));
  await assert.rejects(
    pool.query('UPDATE feature_switch_changes SET enabled = true'),
  );
});

// Display settings (owner, 14 Nov 2026, #216): the pilot notice and the launch time.
test('display settings start unset, so the web keeps its old setting', async (t) => {
  const { db } = await fresh(t);
  const { readDisplaySettings } = await import('../../dist/index.js');
  assert.deepEqual(await readDisplaySettings(db), {
    pilotNotice: { set: false, on: false },
    launch: { set: false, at: null },
  });
});

test('staff set the pilot notice and the launch time; checked, stored as UTC, audited, with history', async (t) => {
  const { db, rows } = await fresh(t);
  const { readDisplaySettings, setDisplaySetting, displaySettingOverview } =
    await import('../../dist/index.js');
  const set = (key, value, reason = 'Agreed with the owner today') =>
    db.transaction((tx) =>
      setDisplaySetting(tx, { key, value, staffUserId: STAFF, reason, now: new Date() }),
    );
  assert.deepEqual(await set('pilot_notice', 'on'), {
    key: 'pilot_notice',
    value: 'on',
    previous: null,
  });
  await set('production_launch_at', '2026-12-01T00:00:00+01:00');
  assert.deepEqual(await readDisplaySettings(db), {
    pilotNotice: { set: true, on: true },
    launch: { set: true, at: '2026-11-30T23:00:00.000Z' },
  });
  // No launch time: open now. Still "set", so the web stops reading its old setting.
  await set('production_launch_at', null);
  assert.deepEqual((await readDisplaySettings(db)).launch, { set: true, at: null });
  for (const [key, value] of [
    ['pilot_notice', 'on'],
    ['pilot_notice', 'yes'],
    ['production_launch_at', 'tomorrow'],
    ['nope', 'on'],
  ])
    await assert.rejects(set(key, value), (error) => error.code === 'INVALID_INPUT', `${key}=${value}`);
  const audits = await rows(
    `SELECT subject_id, permission FROM audit_events WHERE action = 'display_setting.set' ORDER BY created_at`,
  );
  assert.equal(audits.length, 3);
  assert.ok(audits.every((a) => a.permission === 'switches.manage'));
  const overview = await displaySettingOverview(db);
  const launch = overview.find((s) => s.key === 'production_launch_at');
  assert.equal(launch.set, true);
  assert.equal(launch.value, null);
  assert.equal(launch.envName, 'PRODUCTION_LAUNCH_AT');
  assert.equal(launch.history.length, 2);
  await assert.rejects(rows('DELETE FROM display_setting_changes'));
});

test('display settings are cached like switches, and a failed read keeps the last known, else unset', async (t) => {
  const { db, pool } = await fresh(t);
  const { displaySettingsNow, setDisplaySetting } = await import('../../dist/index.js');
  await db.transaction((tx) =>
    setDisplaySetting(tx, {
      key: 'pilot_notice',
      value: 'on',
      staffUserId: STAFF,
      reason: 'Pilot with real payments',
      now: new Date(),
    }),
  );
  invalidateFeatureSwitches();
  const start = Date.now();
  assert.equal((await displaySettingsNow(db, { now: start })).pilotNotice.on, true);
  await pool.query(`UPDATE display_settings SET value = 'off'`);
  assert.equal((await displaySettingsNow(db, { now: start + 1000 })).pilotNotice.on, true, 'cached');
  invalidateFeatureSwitches();
  assert.equal((await displaySettingsNow(db, { now: start + 1000 })).pilotNotice.on, false);
  let fail = false;
  const flaky = {
    select: (...args) => {
      if (fail) throw new Error('connection refused');
      return db.select(...args);
    },
  };
  invalidateFeatureSwitches();
  assert.equal((await displaySettingsNow(flaky)).pilotNotice.set, true);
  fail = true;
  invalidateFeatureSwitches();
  assert.equal((await displaySettingsNow(flaky)).pilotNotice.set, true, 'last known');
  const never = { select() { throw new Error('connection refused'); } };
  assert.deepEqual(await displaySettingsNow(never), {
    pilotNotice: { set: false, on: false },
    launch: { set: false, at: null },
  });
});
