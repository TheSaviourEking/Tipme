import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countdownAnnouncement,
  countdownParts,
  launchMinuteBucket,
  LAGOS_LAUNCH_LABEL,
  LAGOS_LAUNCH_TARGET,
} from '../src/lib/countdown.ts';

test('the countdown decomposes one fixed interval without floating point drift', () => {
  const target = Date.parse('2026-10-26T23:00:00Z');
  assert.deepEqual(
    countdownParts(
      target,
      target - ((2 * 24 + 3) * 60 * 60 + 4 * 60 + 5) * 1000,
    ),
    { days: 2, hours: 3, minutes: 4, seconds: 5, complete: false },
  );
});

test('the countdown clamps to zero at and after launch', () => {
  const target = 1_000;
  for (const now of [target, target + 90_000])
    assert.deepEqual(countdownParts(target, now), {
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      complete: true,
    });
});

test('assistive technology receives one combined, human announcement', () => {
  assert.equal(
    countdownAnnouncement({
      days: 1,
      hours: 2,
      minutes: 1,
      seconds: 40,
      complete: false,
    }),
    '1 day, 2 hours and 1 minute until TipMe opens.',
  );
  assert.equal(
    countdownAnnouncement({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      complete: true,
    }),
    'TipMe is open.',
  );
});

test('the announcement bucket changes at most once per remaining minute', () => {
  const target = 120_000;
  assert.equal(launchMinuteBucket(target, 1), 2);
  assert.equal(launchMinuteBucket(target, 59_999), 2);
  assert.equal(launchMinuteBucket(target, 60_000), 1);
  assert.equal(launchMinuteBucket(target, target), 0);
  assert.equal(launchMinuteBucket(target, target + 1), 0);
});

test('the public target label and UTC instant describe Lagos midnight', () => {
  assert.equal(LAGOS_LAUNCH_TARGET, '2026-10-26T23:00:00Z');
  assert.equal(LAGOS_LAUNCH_LABEL, '27 October 2026 · 00:00 WAT');
  assert.equal(
    Date.parse(LAGOS_LAUNCH_TARGET),
    Date.parse('2026-10-27T00:00:00+01:00'),
  );
});
