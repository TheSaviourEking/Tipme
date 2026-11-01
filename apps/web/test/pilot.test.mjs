import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PILOT_NOTICE_SUPPORT_EMAIL,
  PILOT_NOTICE_TEXT,
  pilotNoticeOn,
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
