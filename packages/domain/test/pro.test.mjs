import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRO_GRACE_DAYS,
  nextPeriodStart,
  proGraceEnd,
  proPeriodEnd,
} from '../dist/index.js';

// Paid Pro (ADR-0015): a month is a calendar month in Lagos (UTC+1, no daylight saving).
const lagos = (iso) => new Date(`${iso}+01:00`);

test('31 Jan 2027 10:00 Lagos ends 28 Feb 2027 10:00 Lagos', () => {
  assert.equal(
    proPeriodEnd(lagos('2027-01-31T10:00:00')).toISOString(),
    lagos('2027-02-28T10:00:00').toISOString(),
  );
});

test('in a leap year it ends on 29 Feb', () => {
  assert.equal(
    proPeriodEnd(lagos('2028-01-31T10:00:00')).toISOString(),
    lagos('2028-02-29T10:00:00').toISOString(),
  );
});

test('a month started on the 15th ends on the 15th; December runs into January', () => {
  assert.equal(
    proPeriodEnd(lagos('2026-11-15T08:30:00')).toISOString(),
    lagos('2026-12-15T08:30:00').toISOString(),
  );
  assert.equal(
    proPeriodEnd(lagos('2026-12-31T23:30:00')).toISOString(),
    lagos('2027-01-31T23:30:00').toISOString(),
  );
  // 00:30 Lagos on 1 Dec is still 30 Nov in UTC: the Lagos calendar decides.
  assert.equal(
    proPeriodEnd(lagos('2026-12-01T00:30:00')).toISOString(),
    lagos('2027-01-01T00:30:00').toISOString(),
  );
});

test('grace ends 3 days after the end', () => {
  assert.equal(PRO_GRACE_DAYS, 3);
  const end = lagos('2026-12-09T10:00:00');
  assert.equal(
    proGraceEnd(end).toISOString(),
    lagos('2026-12-12T10:00:00').toISOString(),
  );
});

test('the next month starts at the old end while active or in grace, and now after grace', () => {
  const endsAt = lagos('2026-12-09T10:00:00');
  const latest = { endsAt, graceEndsAt: proGraceEnd(endsAt) };
  const active = lagos('2026-12-01T10:00:00');
  const inGrace = lagos('2026-12-10T10:00:00');
  const after = lagos('2026-12-13T10:00:00');
  assert.equal(
    nextPeriodStart(active, latest).toISOString(),
    endsAt.toISOString(),
  );
  assert.equal(
    nextPeriodStart(inGrace, latest).toISOString(),
    endsAt.toISOString(),
  );
  assert.equal(
    nextPeriodStart(after, latest).toISOString(),
    after.toISOString(),
  );
  assert.equal(nextPeriodStart(after, null).toISOString(), after.toISOString());
});
