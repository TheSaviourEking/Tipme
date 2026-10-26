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
