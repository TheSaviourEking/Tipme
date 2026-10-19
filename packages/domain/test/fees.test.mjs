import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AmountOutOfRangeError,
  MOCK_FEE_POLICY_V0,
  priceTip,
} from '../dist/index.js';

test('the mock policy deducts the cut and provider fee from the tip, rounding half up', () => {
  assert.equal(MOCK_FEE_POLICY_V0.version, 'mock-v0');
  assert.deepEqual(priceTip(100000n), {
    tipMinor: 100000n,
    platformFeeMinor: 5000n,
    providerFeeMinor: 1500n,
    payerTotalMinor: 100000n,
    recipientNetMinor: 93500n,
  });
  const small = priceTip(100n);
  assert.equal(small.platformFeeMinor, 5n);
  assert.equal(small.providerFeeMinor, 2n);
  assert.equal(small.recipientNetMinor, 93n);
});

test('tips outside the sample range are refused', () => {
  assert.throws(() => priceTip(99n), AmountOutOfRangeError);
  assert.throws(() => priceTip(10_000_001n), AmountOutOfRangeError);
});
