import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WHATS_NEW_SEEN,
  dayLabel,
  groupByDay,
  hasNewUpdates,
  newestLiveAt,
  slipWords,
} from '../src/lib/whats-new.ts';

// Changelog plan (5 Nov 2026), Task 6.3: what the menu dot, the Home slip and the page show.
const entry = (number, liveOn, extra = {}) => ({
  number,
  line: `Update ${number}.`,
  pro: false,
  liveOn,
  liveAt: `${liveOn}T10:00:00.000Z`,
  ...extra,
});

test('dayLabel reads a Lagos date as "6 November 2026", whatever the browser zone', () => {
  assert.equal(dayLabel('2026-11-06'), '6 November 2026');
  assert.equal(dayLabel('2026-01-01'), '1 January 2026');
});

test('groupByDay keeps the server order and puts entries under their day', () => {
  const groups = groupByDay([
    entry(3, '2026-11-06'),
    entry(2, '2026-11-06'),
    entry(1, '2026-11-03'),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.entries.map((e) => e.number)]),
    [
      ['6 November 2026', [3, 2]],
      ['3 November 2026', [1]],
    ],
  );
  assert.deepEqual(groupByDay([]), []);
});

test('the dot shows only while something is unseen, and never without a status (older API)', () => {
  assert.equal(hasNewUpdates(null), false);
  assert.equal(
    hasNewUpdates({ unseen: 0, newest: entry(1, '2026-11-06') }),
    false,
  );
  assert.equal(
    hasNewUpdates({ unseen: 2, newest: entry(1, '2026-11-06') }),
    true,
  );
});

test('the slip shows the newest line once, with "and N more" when several are unseen', () => {
  assert.equal(slipWords(null), null);
  assert.equal(slipWords({ unseen: 0, newest: entry(1, '2026-11-06') }), null);
  assert.equal(slipWords({ unseen: 1, newest: null }), null);
  assert.deepEqual(slipWords({ unseen: 1, newest: entry(7, '2026-11-06') }), {
    title: 'New in TipMe',
    line: 'Update 7.',
    more: null,
  });
  assert.deepEqual(slipWords({ unseen: 3, newest: entry(7, '2026-11-06') }), {
    title: 'New in TipMe',
    line: 'Update 7.',
    more: 'and 2 more',
  });
});

test('seen is sent through the newest entry shown, as an instant', () => {
  assert.equal(newestLiveAt([]), null);
  assert.equal(
    newestLiveAt([entry(2, '2026-11-06'), entry(1, '2026-11-03')]),
    '2026-11-06T10:00:00.000Z',
  );
  assert.equal(typeof WHATS_NEW_SEEN, 'string');
});
