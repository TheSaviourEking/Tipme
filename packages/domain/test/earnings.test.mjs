import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  averageTipMinor,
  bestWeekday,
  campaignSlugProblem,
  earningsNotes,
  earningsWindow,
} from '../dist/index.js';

// Earnings analytics (Pro, ProEarnings board): Lagos calendar, weeks from Monday, a period that
// isn't over compared with the same days of the one before, and notes that state facts only.

test('this month so far (1–8 Nov) is compared with 1–8 Oct, never the whole of October', () => {
  const window = earningsWindow('month', '2026-11-08', '2026-11-08');
  assert.deepEqual(window, {
    from: '2026-11-01',
    to: '2026-11-08',
    complete: false,
    previous: { from: '2026-10-01', to: '2026-10-08' },
  });
});

test('a finished month is compared with the whole month before', () => {
  assert.deepEqual(earningsWindow('month', '2026-10-15', '2026-11-08'), {
    from: '2026-10-01',
    to: '2026-10-31',
    complete: true,
    previous: { from: '2026-09-01', to: '2026-09-30' },
  });
});

test('31 March so far is compared with 1–28 Feb (the shorter month is clamped)', () => {
  assert.deepEqual(
    earningsWindow('month', '2027-03-31', '2027-03-31').previous,
    { from: '2027-02-01', to: '2027-02-28' },
  );
});

test('weeks start on Monday; this week so far is compared with the same days last week', () => {
  // Sunday 8 Nov 2026: the week ran Mon 2 – Sun 8 Nov, so it is the whole week, still open today.
  assert.deepEqual(earningsWindow('week', '2026-11-08', '2026-11-08'), {
    from: '2026-11-02',
    to: '2026-11-08',
    complete: false,
    previous: { from: '2026-10-26', to: '2026-11-01' },
  });
  assert.deepEqual(earningsWindow('week', '2026-11-04', '2026-11-04'), {
    from: '2026-11-02',
    to: '2026-11-04',
    complete: false,
    previous: { from: '2026-10-26', to: '2026-10-28' },
  });
});

test('a year so far is compared with the same days of last year', () => {
  assert.deepEqual(earningsWindow('year', '2026-03-01', '2026-11-08'), {
    from: '2026-01-01',
    to: '2026-11-08',
    complete: false,
    previous: { from: '2025-01-01', to: '2025-11-08' },
  });
});

test('a day after today has no window', () => {
  assert.equal(earningsWindow('month', '2026-12-01', '2026-11-08'), null);
  assert.equal(earningsWindow('month', '2026-13-01', '2026-11-08'), null);
});

test('the average tip is exact to the kobo, rounded half up', () => {
  assert.equal(averageTipMinor(18630000n, 41), 454390n);
  assert.equal(averageTipMinor(1000n, 3), 333n);
  assert.equal(averageTipMinor(1001n, 2), 501n);
  assert.equal(averageTipMinor(0n, 0), null);
});

const days = (sat) => [4, 5, 3, 6, 6, sat, 41 - 24 - sat];

test('best day: Saturday 13 of 41 is shown', () => {
  assert.deepEqual(bestWeekday([4, 5, 3, 6, 6, 13, 4], 41), {
    weekday: 5,
    tips: 13,
  });
});

test('best day: 4 of 41 is not enough (needs 5 and a quarter)', () => {
  assert.equal(bestWeekday([4, 4, 4, 4, 4, 4, 4], 28), null);
  // 9 of 41 is at least 5 but under a quarter.
  assert.equal(bestWeekday(days(9), 41), null);
});

const october = {
  tips: 41,
  averageMinor: 454390n,
  previous: { tips: 37, averageMinor: 411100n, label: 'in September' },
  best: { weekday: 5, tips: 13 },
  repeatSupporters: 9,
};

test('notes: Saturday 13 of 41, repeat supporters and the average', () => {
  assert.deepEqual(earningsNotes(october), [
    'Most of your tips came on Saturdays: 13 of 41.',
    '9 people tipped you more than once.',
    'Your average tip went from ₦4,111 in September to ₦4,543.90.',
  ]);
});

test('notes: 9 tips → no notes at all', () => {
  assert.deepEqual(earningsNotes({ ...october, tips: 9 }), []);
});

test('notes: no best day, one repeat supporter, the same average → one note', () => {
  assert.deepEqual(
    earningsNotes({
      ...october,
      best: null,
      repeatSupporters: 1,
      previous: { tips: 37, averageMinor: 454390n, label: 'in September' },
    }),
    ['1 person tipped you more than once.'],
  );
});

test('notes never claim a cause, advise, or use AI words', () => {
  const text = earningsNotes(october).join(' ');
  assert.doesNotMatch(text, /because|should|try|AI|smart|predict/i);
});

test('campaign link endings: letters, numbers and dashes; not TipMe words or route names', () => {
  assert.equal(campaignSlugProblem('new-single'), null);
  assert.equal(campaignSlugProblem('ig'), null);
  assert.equal(campaignSlugProblem('New-Single'), 'format');
  assert.equal(campaignSlugProblem('-x'), 'format');
  assert.equal(campaignSlugProblem('a'.repeat(31)), 'format');
  assert.equal(campaignSlugProblem('settings'), 'reserved');
  assert.equal(campaignSlugProblem('share-card'), 'reserved');
  assert.equal(campaignSlugProblem('how-it-works'), 'reserved');
});
