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

// The starting amount ("Make it yours", PR B): sent only for a Pro page's own payable amounts.
test('a Pro page with a saved start among its amounts sends it', () => {
  assert.deepEqual(
    tipAmountsOf({
      ...pro([500_000n, 1_000_000n, 2_000_000n], 500_000n),
      tipStartMinor: 1_000_000n,
    }),
    {
      presetsMinor: ['500000', '1000000', '2000000'],
      minMinor: '500000',
      startMinor: '1000000',
    },
  );
});

test('a Free page sends no start, whatever is saved', () => {
  assert.deepEqual(
    tipAmountsOf({
      plan: 'free',
      tipPresetsMinor: [500_000n, 1_000_000n],
      minTipMinor: 500_000n,
      tipStartMinor: 1_000_000n,
    }),
    { presetsMinor: ['200000', '500000', '1000000'], minMinor: '200000' },
  );
});

test('a start below the floor (an old saved amount) is not sent', () => {
  assert.deepEqual(
    tipAmountsOf({
      ...pro([100_000n, 500_000n], 100_000n),
      tipStartMinor: 100_000n,
    }),
    { presetsMinor: ['500000'], minMinor: '200000' },
  );
});

test('a start is never sent with the standard amounts a Pro page falls back to', () => {
  // Every own amount is under the floor, so the page offers the standard ones, which include ₦5,000;
  // a start saved for the page's own amounts does not carry over to them.
  assert.deepEqual(
    tipAmountsOf({ ...pro([150_000n], 100_000n), tipStartMinor: 150_000n }),
    { presetsMinor: ['200000', '500000', '1000000'], minMinor: '200000' },
  );
});

test('no saved start sends none', () => {
  assert.deepEqual(
    tipAmountsOf({ ...pro([300_000n], 250_000n), tipStartMinor: null }),
    { presetsMinor: ['300000'], minMinor: '250000' },
  );
});
