import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PILOT_NOTICE_SUPPORT_EMAIL,
  PILOT_NOTICE_TEXT,
  pilotNoticeOn,
  pilotNoticeShown,
} from '../src/lib/pilot.ts';

test('the pilot notice is on only when PILOT_NOTICE is exactly "on"', () => {
  assert.equal(pilotNoticeOn({ PILOT_NOTICE: 'on' }), true);
  for (const value of [undefined, '', 'off', 'ON', 'true', '1', ' on', 'on '])
    assert.equal(pilotNoticeOn({ PILOT_NOTICE: value }), false, String(value));
  assert.equal(pilotNoticeOn({}), false);
});

test('the notice copy is the owner-reviewed sentence and names no payment provider', () => {
  assert.equal(PILOT_NOTICE_SUPPORT_EMAIL, 'support@usetipme.xyz');
  assert.equal(
    `${PILOT_NOTICE_TEXT} ${PILOT_NOTICE_SUPPORT_EMAIL}`,
    'TipMe is in a pilot. Payments are real. Need help? support@usetipme.xyz',
  );
  assert.doesNotMatch(PILOT_NOTICE_TEXT, /bachs/i);
});

test('the notice is shown only when switched on AND payments are live', () => {
  const unset = {
    pilotNotice: { set: false, on: false },
    launch: { set: false, at: null },
  };
  const on = { ...unset, pilotNotice: { set: true, on: true } };
  // "Payments are real" must never appear on a test copy or before payments are switched on.
  assert.equal(pilotNoticeShown(on, {}, 'live'), true);
  assert.equal(pilotNoticeShown(on, {}, 'test'), false);
  assert.equal(pilotNoticeShown(on, {}, 'closed'), false);
  // Not yet set in admin: the old PILOT_NOTICE setting still decides (owner, 14 Nov 2026, #216).
  assert.equal(pilotNoticeShown(unset, { PILOT_NOTICE: 'on' }, 'live'), true);
  for (const mode of ['test', 'closed', 'live']) {
    assert.equal(pilotNoticeShown(unset, {}, mode), false, `unset, ${mode}`);
    assert.equal(
      pilotNoticeShown(null, { PILOT_NOTICE: 'on' }, mode),
      false,
      `unreadable, ${mode}`,
    );
  }
});
