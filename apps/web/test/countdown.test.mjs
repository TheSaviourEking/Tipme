import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  countdownAnnouncement,
  countdownParts,
  launchIso,
  launchLabel,
  launchMinuteBucket,
  launchShortLabel,
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

test('the default launch instant is Lagos midnight on 27 October', () => {
  assert.equal(LAGOS_LAUNCH_TARGET, '2026-10-26T23:00:00Z');
  assert.equal(
    Date.parse(LAGOS_LAUNCH_TARGET),
    Date.parse('2026-10-27T00:00:00+01:00'),
  );
  assert.equal(
    launchLabel(Date.parse(LAGOS_LAUNCH_TARGET)),
    '27 October 2026 · 00:00 WAT',
  );
});

test('launchLabel writes the Lagos date and time', () => {
  assert.equal(
    launchLabel(Date.parse('2026-10-26T23:00:00Z')),
    '27 October 2026 · 00:00 WAT',
  );
  assert.equal(
    launchLabel(Date.parse('2027-01-15T08:30:00Z')),
    '15 January 2027 · 09:30 WAT',
  );
  // Crosses the year in Lagos, not in UTC.
  assert.equal(
    launchLabel(Date.parse('2026-12-31T23:30:00Z')),
    '1 January 2027 · 00:30 WAT',
  );
});

test('launchShortLabel drops the year', () => {
  assert.equal(
    launchShortLabel(Date.parse('2026-10-26T23:00:00Z')),
    '27 October · 00:00 WAT',
  );
  assert.equal(
    launchShortLabel(Date.parse('2027-01-15T08:30:00Z')),
    '15 January · 09:30 WAT',
  );
});

test('launchIso gives the machine-readable instant for <time datetime>', () => {
  assert.equal(
    launchIso(Date.parse('2027-01-15T09:30:00+01:00')),
    '2027-01-15T08:30:00.000Z',
  );
});

test('no fixed launch label is left in the page or its card', () => {
  for (const file of [
    '../src/app/coming-soon/page.tsx',
    '../src/app/coming-soon/opengraph-image.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /27 October/, file);
    assert.doesNotMatch(source, /LAGOS_LAUNCH_LABEL/, file);
  }
});
