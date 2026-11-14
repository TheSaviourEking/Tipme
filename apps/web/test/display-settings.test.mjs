import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDisplaySettingsReader,
  displaySettingsOf,
  launchTargetFrom,
  pilotNoticeFrom,
} from '../src/lib/display-settings.ts';

// Display settings (owner, 14 Nov 2026, #216): the pilot notice and the launch time come from admin,
// on the API's /health/release. Until staff first set one there, the web keeps its old setting.

const unset = {
  pilotNotice: { set: false, on: false },
  launch: { set: false, at: null },
};
const launchIso = '2026-12-31T23:00:00.000Z';

test('the settings are read from the release answer; anything malformed is unreadable', () => {
  assert.deepEqual(displaySettingsOf({ display: unset }), unset);
  for (const bad of [
    null,
    {},
    { display: null },
    { display: { pilotNotice: {} } },
    'x',
  ])
    assert.equal(displaySettingsOf(bad), null);
});

test('the pilot notice: admin wins once set; unset in admin, the old setting; unreadable, none', () => {
  const on = { PILOT_NOTICE: 'on' };
  assert.equal(
    pilotNoticeFrom({ ...unset, pilotNotice: { set: true, on: true } }, {}),
    true,
  );
  assert.equal(
    pilotNoticeFrom({ ...unset, pilotNotice: { set: true, on: false } }, on),
    false,
  );
  assert.equal(pilotNoticeFrom(unset, on), true);
  assert.equal(pilotNoticeFrom(unset, {}), false);
  // The API down and nothing known: no notice (owner, #216).
  assert.equal(pilotNoticeFrom(null, on), false);
});

test('the launch: admin wins once set (none is open); unset, the old setting; unreadable, open', () => {
  const env = { PRODUCTION_LAUNCH_AT: '2027-02-01T00:00:00Z' };
  assert.equal(
    launchTargetFrom({ ...unset, launch: { set: true, at: launchIso } }, env),
    Date.parse(launchIso),
  );
  assert.equal(
    launchTargetFrom({ ...unset, launch: { set: true, at: null } }, env),
    null,
  );
  assert.equal(
    launchTargetFrom(unset, env),
    Date.parse('2027-02-01T00:00:00Z'),
  );
  assert.equal(launchTargetFrom(unset, {}), null);
  // As with the old setting unset: the launch counts as passed (owner, #216).
  assert.equal(launchTargetFrom(null, env), null);
  assert.throws(
    () => launchTargetFrom(unset, { PRODUCTION_LAUNCH_AT: 'soon' }),
    /PRODUCTION_LAUNCH_AT/,
  );
});

test('the reader asks at most once a minute, keeps the last known on a failure, else unreadable', async () => {
  let clock = 0;
  let calls = 0;
  let answer = () => ({
    display: { ...unset, pilotNotice: { set: true, on: true } },
  });
  const read = createDisplaySettingsReader({
    read: async () => {
      calls += 1;
      return answer();
    },
    now: () => clock,
  });
  assert.equal((await read()).pilotNotice.on, true);
  clock = 59_000;
  await read();
  assert.equal(calls, 1);
  clock = 61_000;
  answer = () => {
    throw new Error('API down');
  };
  assert.equal((await read()).pilotNotice.on, true, 'last known');
  assert.equal(calls, 2);
  clock = 62_000;
  await read();
  assert.equal(
    calls,
    2,
    'a failure is retried after a few seconds, not every call',
  );

  const never = createDisplaySettingsReader({
    read: async () => {
      throw new Error('API down');
    },
    now: () => 0,
  });
  assert.equal(await never(), null);
});
