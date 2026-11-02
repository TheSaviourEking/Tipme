import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountOptions } from '../src/lib/tip-amounts.ts';

test('without amounts from the API (an older API), the standard Free amounts apply', () => {
  const options = amountOptions(undefined);
  assert.deepEqual(
    options.presets.map((p) => [p.label, p.minor]),
    [
      ['1,000', 100000],
      ['2,000', 200000],
      ['5,000', 500000],
    ],
  );
  assert.equal(options.rangeText, 'NGN 1,000 or more');
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

test('a page without NGN 2,000 starts with nothing chosen, never a guess', () => {
  assert.equal(
    amountOptions({
      presetsMinor: ['500000', '1000000'],
      minMinor: '500000',
    }).defaultMinor,
    null,
  );
  assert.equal(
    amountOptions({ presetsMinor: [], minMinor: '100000' }).defaultMinor,
    null,
  );
});
