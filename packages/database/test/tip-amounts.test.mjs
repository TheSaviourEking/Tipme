import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tipAmountsOf } from '../dist/index.js';

const pro = (tipPresetsMinor, minTipMinor) => ({
  plan: 'pro',
  tipPresetsMinor,
  minTipMinor,
});

test('a Pro page saved under the old ₦1,000 floor offers only what can be paid', () => {
  assert.deepEqual(
    tipAmountsOf(pro([100_000n, 150_000n, 300_000n], 100_000n)),
    {
      presetsMinor: ['300000'],
      minMinor: '200000',
    },
  );
});

test('a Pro page with nothing left at the floor falls back to the standard amounts', () => {
  assert.deepEqual(tipAmountsOf(pro([100_000n, 150_000n], 100_000n)), {
    presetsMinor: ['200000', '500000', '1000000'],
    minMinor: '200000',
  });
});

test("a Pro page's own amounts above the floor are untouched", () => {
  assert.deepEqual(tipAmountsOf(pro([300_000n, 700_000n], 250_000n)), {
    presetsMinor: ['300000', '700000'],
    minMinor: '250000',
  });
});

test('a Free page ignores saved amounts', () => {
  assert.deepEqual(
    tipAmountsOf({
      plan: 'free',
      tipPresetsMinor: [900_000n],
      minTipMinor: 900_000n,
    }),
    { presetsMinor: ['200000', '500000', '1000000'], minMinor: '200000' },
  );
});
