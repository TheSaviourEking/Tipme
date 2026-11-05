import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arrivals,
  balanceRose,
  canInsertInPlace,
  idsOf,
  newlyConfirmed,
  statesOf,
  updatedLabel,
} from '../src/lib/live-merge.ts';

const tip = (id, state = 'paid') => ({
  kind: 'tip',
  id,
  at: '2026-11-05T12:00:00Z',
  amountMinor: '180000',
  state,
  supporterLabel: 'Chidi',
});
const withdrawal = (id) => ({
  ...tip(id, 'requested'),
  kind: 'withdrawal',
  supporterLabel: null,
});

test('the first load marks nothing as arriving', () => {
  assert.deepEqual([...arrivals(null, [tip('a'), tip('b')])], []);
  assert.deepEqual([...newlyConfirmed(null, [tip('a')])], []);
});

test('only a new paid tip arrives; a new confirming tip and a new withdrawal do not', () => {
  const before = idsOf([tip('a')]);
  const rows = [tip('n1'), tip('n2', 'confirming'), withdrawal('w1'), tip('a')];
  assert.deepEqual([...arrivals(before, rows)], ['n1']);
});

test('tips that arrive together are all marked in one change', () => {
  const before = idsOf([tip('a')]);
  assert.deepEqual(
    [...arrivals(before, [tip('x'), tip('y'), tip('a')])].sort(),
    ['x', 'y'],
  );
});

test('confirming to paid is newly confirmed, not arriving', () => {
  const rows0 = [tip('a', 'confirming'), tip('b')];
  const rows1 = [tip('a'), tip('b')];
  assert.deepEqual([...arrivals(idsOf(rows0), rows1)], []);
  assert.deepEqual([...newlyConfirmed(statesOf(rows0), rows1)], ['a']);
  // Anything else changing state is not a confirmation.
  assert.deepEqual(
    [...newlyConfirmed(statesOf([tip('c', 'paid')]), [tip('c', 'reversed')])],
    [],
  );
});

test('a withdrawal id that matches a tip id is not confused with it', () => {
  const before = idsOf([withdrawal('same')]);
  assert.deepEqual(
    [...arrivals(before, [tip('same'), withdrawal('same')])],
    ['same'],
  );
});

test('balanceRose is true for a rise and false for a fall, equal values or the first load', () => {
  const s = (availableMinor) => ({ availableMinor });
  assert.equal(balanceRose(s('100'), s('200')), true);
  assert.equal(balanceRose(s('200'), s('100')), false);
  assert.equal(balanceRose(s('200'), s('200')), false);
  assert.equal(balanceRose(null, s('200')), false);
  // Above Number's exact range: no rounding.
  assert.equal(balanceRose(s('9007199254740992'), s('9007199254740993')), true);
  assert.equal(
    balanceRose(s('9007199254740993'), s('9007199254740992')),
    false,
  );
});

test('updatedLabel reads Updated HH:MM in Lagos time', () => {
  assert.equal(updatedLabel(new Date('2026-11-05T13:02:00Z')), 'Updated 14:02');
  assert.equal(updatedLabel(new Date('2026-11-05T23:30:00Z')), 'Updated 00:30');
});

test('canInsertInPlace is false with a search or a later page loaded', () => {
  assert.equal(canInsertInPlace({ searched: '', extraPages: 0 }), true);
  assert.equal(canInsertInPlace({ searched: 'ada', extraPages: 0 }), false);
  assert.equal(canInsertInPlace({ searched: '', extraPages: 1 }), false);
});
