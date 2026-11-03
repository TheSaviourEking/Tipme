import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountOptions,
  keyLayout,
  keysPerRow,
} from '../src/lib/tip-amounts.ts';

test('without amounts from the API (an older API), the standard Free amounts apply', () => {
  const options = amountOptions(undefined);
  assert.deepEqual(
    options.presets.map((p) => [p.label, p.minor]),
    [
      ['2,000', 200000],
      ['5,000', 500000],
      ['10,000', 1000000],
    ],
  );
  assert.equal(options.rangeText, 'NGN 2,000 or more');
});

test('a Pro page’s own presets and minimum are shown and enforced when typing an amount', () => {
  const options = amountOptions({
    presetsMinor: ['200000', '500000', '1000000'],
    minMinor: '200000',
  });
  assert.deepEqual(
    options.presets.map((p) => p.label),
    ['2,000', '5,000', '10,000'],
  );
  assert.equal(options.rangeText, 'NGN 2,000 or more');
  assert.equal(options.parse('1,500'), null, 'below the page minimum');
  assert.equal(options.parse('2000'), 200000);
  assert.equal(options.parse('2,500.50'), 250050);
  assert.equal(options.parse('100,001'), 10000100, 'no maximum');
  assert.equal(options.parse('25,000,000'), 2500000000);
  assert.equal(options.parse('9999999999'), 999999999900);
  assert.equal(
    options.parse('10000000000'),
    null,
    'beyond what the API accepts',
  );
  assert.equal(options.parse('abc'), null);
});

// Owner decision, 2 Nov 2026: the amount picker starts on NGN 2,000. A product default, not an
// approval of anything. A page that does not offer 2,000 starts with nothing chosen, as before.
test('the picker starts on NGN 2,000 when the page offers it', () => {
  assert.equal(amountOptions(undefined).defaultMinor, 200000);
  assert.equal(
    amountOptions({
      presetsMinor: ['200000', '500000', '1000000'],
      minMinor: '200000',
    }).defaultMinor,
    200000,
  );
});

test('a page without NGN 2,000 starts on the closest preset, the lower on a tie', () => {
  const start = (...naira) =>
    amountOptions({
      presetsMinor: naira.map((n) => String(n * 100)),
      minMinor: String(Math.min(...naira) * 100),
    }).defaultMinor;
  assert.equal(start(10_000, 20_000, 50_000, 100_000), 1_000_000);
  assert.equal(start(5_000, 10_000), 500_000);
  assert.equal(start(1_500, 2_500, 9_000), 150_000, 'a tie: the lower');
  assert.equal(start(2_500, 1_500), 150_000, 'a tie, whatever the order');
  assert.equal(start(100, 1_900, 2_200), 190_000);
  assert.equal(start(1_000, 2_000, 5_000), 200_000);
});

test('a page with no presets starts with nothing chosen', () => {
  assert.equal(
    amountOptions({ presetsMinor: [], minMinor: '100000' }).defaultMinor,
    null,
  );
});

test('keys never leave one alone on a row, and rows stay even', () => {
  const rows = (count, perRow) => {
    const out = [];
    for (let left = count; left > 0; left -= perRow)
      out.push(Math.min(left, perRow));
    return out;
  };
  assert.deepEqual(rows(4, keysPerRow(4, 4)), [4]);
  assert.deepEqual(rows(4, keysPerRow(4, 3)), [2, 2]);
  assert.deepEqual(rows(5, keysPerRow(5, 4)), [3, 2]);
  assert.deepEqual(rows(6, keysPerRow(6, 4)), [3, 3]);
  assert.deepEqual(rows(7, keysPerRow(7, 4)), [4, 3]);
  assert.deepEqual(rows(8, keysPerRow(8, 4)), [4, 4]);
  assert.deepEqual(rows(8, keysPerRow(8, 3)), [3, 3, 2]);
  assert.deepEqual(rows(3, keysPerRow(3, 3)), [3]);
  // One a row is a column, not an orphan: the fallback when two won't fit evenly.
  for (let count = 2; count <= 8; count += 1)
    for (let most = 2; most <= 5; most += 1) {
      const perRow = keysPerRow(count, most);
      if (perRow > 1)
        assert.notEqual(
          rows(count, perRow).at(-1),
          1,
          `${count} keys, at most ${most} a row`,
        );
    }
});

test('longer amounts get fewer keys a row in a narrow card', () => {
  assert.deepEqual(keyLayout(['10,000', '20,000', '50,000', '100,000']), {
    small: 2,
    medium: 2,
    large: 4,
  });
  assert.deepEqual(keyLayout(['1,000', '2,000', '5,000']), {
    small: 3,
    medium: 3,
    large: 3,
  });
  assert.equal(keyLayout(['1,000,000', '2,000,000', '3,000,000']).small, 1);
});

test('the typed-amount example is the page’s own minimum', () => {
  assert.equal(amountOptions(undefined).example, '2,000');
  assert.equal(
    amountOptions({ presetsMinor: ['1000000'], minMinor: '1000000' }).example,
    '10,000',
  );
});
