import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEE_WAIVER_STAFF_COPY as C } from '@tipme/contracts/copy';
import {
  endOfLagosDay,
  fromLabel,
  lagosToday,
  startOfLagosDay,
  untilLabel,
} from '../src/lib/fee-waiver-dates.ts';

// Fee waivers (spec 2026-11-23 §6, Review Focus 5): staff pick the last day TipMe pays. The rule
// stores the instant that day ends in Lagos (the next day's 00:00 WAT, UTC+1), and every screen
// shows the day picked, never the day after.

test('an end date is sent as the start of the next Lagos day and shown as the date picked', () => {
  const endsAt = endOfLagosDay('2027-01-31');
  assert.equal(endsAt, '2027-01-31T23:00:00.000Z');
  const inJanuary = new Date('2027-01-10T12:00:00.000Z');
  assert.equal(untilLabel(endsAt, inJanuary), 'until 31 Jan');
});

test('the year is added when the end is not in this Lagos year', () => {
  const now = new Date('2026-11-26T12:00:00.000Z');
  assert.equal(
    untilLabel(endOfLagosDay('2027-01-31'), now),
    'until 31 Jan 2027',
  );
  assert.equal(untilLabel(endOfLagosDay('2026-12-31'), now), 'until 31 Dec');
});

test('a start date is the start of that Lagos day, sent as a UTC Z string', () => {
  assert.equal(startOfLagosDay('2026-12-05'), '2026-12-04T23:00:00.000Z');
});

test('today is the Lagos date, which is ahead of UTC late in the evening', () => {
  assert.equal(lagosToday(new Date('2026-11-26T23:30:00.000Z')), '2026-11-27');
  assert.equal(lagosToday(new Date('2026-11-26T22:59:00.000Z')), '2026-11-26');
});

test('a change set to start later reads with its first Lagos day (final review I4)', () => {
  const now = new Date('2026-11-26T12:00:00.000Z');
  // 1 Dec 00:00 in Lagos is 30 Nov 23:00 UTC.
  assert.equal(fromLabel('2026-11-30T23:00:00.000Z', now), 'from 1 Dec');
  assert.equal(fromLabel('2027-01-05T23:00:00.000Z', now), 'from 6 Jan 2027');
  assert.equal(
    C.upcomingChange(
      fromLabel('2026-11-30T23:00:00.000Z', now),
      'TipMe pays · until 12 Dec',
    ),
    'From 1 Dec: TipMe pays · until 12 Dec',
  );
});
