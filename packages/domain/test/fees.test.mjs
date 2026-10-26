import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AmountOutOfRangeError,
  FEE_POLICY,
  MOCK_FEE_POLICY_V0,
  priceTip,
} from '../dist/index.js';

test('TipMe takes a flat 10% and pays the provider from it: the recipient keeps 90% (ADR-0014)', () => {
  assert.equal(FEE_POLICY.version, 'v1');
  assert.deepEqual(priceTip(200000n), {
    tipMinor: 200000n,
    platformFeeMinor: 20000n,
    providerFeeMinor: 0n,
    payerTotalMinor: 200000n,
    recipientNetMinor: 180000n,
  });
  // Half up to the kobo.
  const odd = priceTip(105n);
  assert.equal(odd.platformFeeMinor, 11n);
  assert.equal(odd.recipientNetMinor, 94n);
});

test('a staff-set account fee replaces the 10%, and a fee-free tip waives it', () => {
  const custom = priceTip(200000n, FEE_POLICY, { platformFeeBps: 500n });
  assert.equal(custom.platformFeeMinor, 10000n);
  assert.equal(custom.recipientNetMinor, 190000n);
  const none = priceTip(200000n, FEE_POLICY, { platformFeeBps: 0n });
  assert.equal(none.recipientNetMinor, 200000n);
  const free = priceTip(200000n, FEE_POLICY, { feeFree: true });
  assert.equal(free.platformFeeMinor, 0n);
  assert.equal(free.recipientNetMinor, 200000n);
  for (const bad of [-1n, 10001n])
    assert.throws(
      () => priceTip(200000n, FEE_POLICY, { platformFeeBps: bad }),
      RangeError,
    );
});

test('the retired mock policy still prices its old quotes the same way', () => {
  assert.equal(MOCK_FEE_POLICY_V0.version, 'mock-v0');
  assert.equal(priceTip(100000n, MOCK_FEE_POLICY_V0).recipientNetMinor, 93500n);
});

test('tips outside the sample range are refused', () => {
  assert.throws(() => priceTip(99n), AmountOutOfRangeError);
  assert.throws(() => priceTip(10_000_001n), AmountOutOfRangeError);
});
