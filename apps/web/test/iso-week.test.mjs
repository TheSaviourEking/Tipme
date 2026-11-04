import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoWeekRange } from '../src/lib/iso-week.ts';

test('an ISO week reads as its Monday to Sunday, in Lagos time', () => {
  const week = isoWeekRange('2026-W44');
  assert.equal(week?.label, '26 Oct to 1 Nov');
  // Monday 26 Oct 00:00 in Lagos is Sunday 25 Oct 23:00 UTC.
  assert.equal(week?.start, Date.UTC(2026, 9, 25, 23));
  assert.equal(week?.end, Date.UTC(2026, 10, 1, 23));
});

test('a week across a year end names both months', () => {
  assert.equal(isoWeekRange('2026-W53')?.label, '28 Dec to 3 Jan');
  assert.equal(isoWeekRange('2027-W01')?.label, '4 Jan to 10 Jan');
});

test('text that is not an ISO week is refused', () => {
  for (const bad of ['', '2026-44', '2026-W00', '2026-W54', 'soon'])
    assert.equal(isoWeekRange(bad), null, bad);
});
