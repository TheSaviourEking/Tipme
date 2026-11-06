import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessSlugProblem,
  firstNameOf,
  INVITATION_DAYS,
  LAGOS_TIME_ZONE,
  lagosWeekOf,
  lagosWeekRange,
  locationSlugProblem,
  NOTE_WINDOW_DAYS,
  onShift,
  SHIFT_MAX_HOURS,
} from '../dist/index.js';

test('the business constants are the plan’s (M4, M9, invitations)', () => {
  assert.equal(SHIFT_MAX_HOURS, 14);
  assert.equal(NOTE_WINDOW_DAYS, 7);
  assert.equal(INVITATION_DAYS, 7);
});

test('slugs: lower-case letters, digits and inner hyphens; 1..40 and 1..30', () => {
  for (const good of ['yellow-chilli', 'vi', 'a', '9', 'a--b', 'a'.repeat(40)])
    assert.equal(businessSlugProblem(good), null, good);
  assert.equal(businessSlugProblem(''), 'empty');
  assert.equal(businessSlugProblem('a'.repeat(41)), 'too_long');
  for (const bad of ['-x', 'x-', 'Yellow', 'a_b', 'a b', 'kémi', 'a.b'])
    assert.equal(businessSlugProblem(bad), 'characters', bad);
  assert.equal(locationSlugProblem('a'.repeat(30)), null);
  assert.equal(locationSlugProblem('a'.repeat(31)), 'too_long');
  assert.equal(locationSlugProblem(''), 'empty');
  assert.equal(locationSlugProblem('Ikoyi'), 'characters');
});

test('onShift: open and under 14 hours; ended; 14h01m is not', () => {
  const now = new Date('2026-11-06T20:00:00Z');
  const ago = (minutes) => new Date(now.getTime() - minutes * 60_000);
  assert.equal(onShift(null, now), false);
  assert.equal(onShift({ startedAt: ago(60), endedAt: null }, now), true);
  assert.equal(onShift({ startedAt: ago(14 * 60), endedAt: null }, now), true);
  assert.equal(
    onShift({ startedAt: ago(14 * 60 + 1), endedAt: null }, now),
    false,
  );
  assert.equal(onShift({ startedAt: ago(60), endedAt: ago(5) }, now), false);
  // A start in the future (clock skew) is not a shift yet.
  assert.equal(onShift({ startedAt: ago(-5), endedAt: null }, now), false);
});

test('Lagos is a fixed UTC+1 all year (no daylight saving), as the helpers assume', () => {
  assert.equal(LAGOS_TIME_ZONE, 'Africa/Lagos');
  const hourIn = (at) =>
    Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: LAGOS_TIME_ZONE,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(at),
    );
  for (let month = 0; month < 12; month += 1) {
    const at = new Date(Date.UTC(2026, month, 15, 10));
    assert.equal(hourIn(at), 11, `month ${month + 1}`);
  }
});

test('lagosWeekOf: Sunday 23:30 UTC is Monday in Lagos (UTC+1) and starts the next week', () => {
  // Sunday 8 Nov 2026 is the last day of 2026-W45.
  assert.equal(lagosWeekOf(new Date('2026-11-08T22:59:59Z')), '2026-W45');
  assert.equal(lagosWeekOf(new Date('2026-11-08T23:30:00Z')), '2026-W46');
  assert.equal(lagosWeekOf(new Date('2026-11-02T00:00:00Z')), '2026-W45');
  // ISO years: 1 Jan 2027 (a Friday) belongs to 2026-W53; 2026 has 53 weeks.
  assert.equal(lagosWeekOf(new Date('2027-01-01T12:00:00Z')), '2026-W53');
  assert.equal(lagosWeekOf(new Date('2027-01-04T12:00:00Z')), '2027-W01');
});

test('lagosWeekRange round-trips and refuses 2026-W54 and junk', () => {
  const range = lagosWeekRange('2026-W46');
  assert.deepEqual(range, {
    from: new Date('2026-11-08T23:00:00Z'),
    to: new Date('2026-11-15T23:00:00Z'),
  });
  for (const week of [
    '2026-W01',
    '2026-W45',
    '2026-W53',
    '2027-W01',
    '2020-W53',
  ])
    assert.equal(lagosWeekOf(lagosWeekRange(week).from), week, week);
  for (const week of [
    '2026-W54',
    '2027-W53',
    '2026-W00',
    '2026-W1',
    'junk',
    '',
    '2026-45',
  ])
    assert.equal(lagosWeekRange(week), null, week);
  // Every instant of the week maps back to it; the end is exclusive.
  assert.equal(lagosWeekOf(new Date(range.to.getTime() - 1)), '2026-W46');
  assert.equal(lagosWeekOf(range.to), '2026-W47');
});

test('firstNameOf: "Tobi Adeyemi" -> "Tobi"; trims; caps at 30 code points', () => {
  assert.equal(firstNameOf('Tobi Adeyemi'), 'Tobi');
  assert.equal(firstNameOf('  Ada\tLovelace '), 'Ada');
  assert.equal(firstNameOf('Chioma'), 'Chioma');
  assert.equal(firstNameOf('😀'.repeat(31)), '😀'.repeat(30));
  assert.equal(firstNameOf('W'.repeat(60)), 'W'.repeat(30));
});
