import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lagosDateWords, takeBackDueAt } from '../dist/index.js';

test('takeBackDueAt is the end of the Lagos day, notice_days later', () => {
  assert.equal(
    takeBackDueAt(new Date('2026-11-03T10:00:00Z'), 7).toISOString(),
    '2026-11-10T22:59:59.999Z',
  );
  // 23:30 UTC is 00:30 on 4 November in Lagos, so the count starts from the 4th.
  assert.equal(
    takeBackDueAt(new Date('2026-11-03T23:30:00Z'), 7).toISOString(),
    '2026-11-11T22:59:59.999Z',
  );
  assert.equal(
    takeBackDueAt(new Date('2026-11-03T10:00:00Z'), 1).toISOString(),
    '2026-11-04T22:59:59.999Z',
  );
});

test('there are always at least notice_days full days', () => {
  const DAY = 86_400_000;
  const start = Date.parse('2026-11-03T00:00:00Z');
  for (const days of [1, 4, 7, 30])
    for (let hour = 0; hour < 48; hour++) {
      const noticed = new Date(start + hour * 3_600_000);
      const due = takeBackDueAt(noticed, days);
      assert.ok(
        due.getTime() - noticed.getTime() >= days * DAY - 1,
        `${noticed.toISOString()} + ${days}`,
      );
      // And never a whole extra day beyond that.
      assert.ok(due.getTime() - noticed.getTime() < (days + 1) * DAY);
      // Always the last moment of a Lagos day.
      assert.equal(due.toISOString().slice(11), '22:59:59.999Z');
    }
});

test('lagosDateWords writes the date out', () => {
  assert.equal(
    lagosDateWords(new Date('2026-11-10T22:59:59.999Z')),
    '10 November 2026',
  );
  // 23:30 UTC on the 10th is already the 11th in Lagos.
  assert.equal(
    lagosDateWords(new Date('2026-11-10T23:30:00Z')),
    '11 November 2026',
  );
});
