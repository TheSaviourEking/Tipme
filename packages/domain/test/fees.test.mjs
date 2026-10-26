import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AmountOutOfRangeError,
  FEE_POLICY_V1,
  priceTip,
} from '../dist/index.js';

// PRD v1.1 proposed commercial rules (pretend money until approved): TipMe keeps 10% of the tip
// and pays the processing fee out of that share; the recipient receives 90%.

const parts = (b) =>
  b.platformFeeMinor + b.providerFeeMinor + b.recipientNetMinor;

test('the PRD example: a ₦5,000 tip gives ₦500 to TipMe (processing included) and ₦4,500 to the recipient', () => {
  assert.equal(FEE_POLICY_V1.version, 'proposed-v1.1');
  const quote = priceTip(500000n);
  assert.equal(quote.platformFeeMinor + quote.providerFeeMinor, 50000n);
  assert.equal(quote.providerFeeMinor, 7500n, 'estimated processing, 1.5%');
  assert.equal(
    quote.platformFeeMinor,
    42500n,
    'what TipMe keeps after processing',
  );
  assert.equal(quote.recipientNetMinor, 450000n);
  assert.equal(quote.payerTotalMinor, 500000n);
});

test('the parts always add up to the tip, rounding half up, and processing never exceeds TipMe’s share', () => {
  for (const tip of [
    100000n,
    100001n,
    123457n,
    999999n,
    10_000_000n,
    999_999_999_999n,
  ]) {
    const quote = priceTip(tip);
    assert.equal(parts(quote), tip, String(tip));
    assert.ok(quote.platformFeeMinor >= 0n);
    assert.equal(quote.recipientNetMinor, tip - (tip * 1000n + 5000n) / 10000n);
  }
});

test('tips below ₦1,000 are refused; there is no maximum: supporters tip what they want', () => {
  assert.throws(() => priceTip(99999n), AmountOutOfRangeError);
  assert.equal(priceTip(10_000_001n).recipientNetMinor, 9_000_001n);
  assert.equal(priceTip(500_000_000_00n).recipientNetMinor, 450_000_000_00n);
  assert.equal('maxTipMinor' in FEE_POLICY_V1, false);
  assert.equal(FEE_POLICY_V1.minTipMinor, 100000n);
  assert.equal(FEE_POLICY_V1.minWithdrawalMinor, 100000n);
});

test('a Pro page’s own minimum raises the floor and never lowers it', () => {
  assert.throws(
    () => priceTip(150000n, FEE_POLICY_V1, { minTipMinor: 200000n }),
    AmountOutOfRangeError,
  );
  assert.equal(
    priceTip(200000n, FEE_POLICY_V1, { minTipMinor: 200000n }).tipMinor,
    200000n,
  );
  assert.throws(
    () => priceTip(50000n, FEE_POLICY_V1, { minTipMinor: 10000n }),
    AmountOutOfRangeError,
    'a page minimum below ₦1,000 does not lower the floor',
  );
});

test('a Pro page’s amounts: 1–4 unique presets in whole naira, each at least its minimum (no maximum); minimum at least ₦1,000', async () => {
  const { tipAmountsProblem } = await import('../dist/index.js');
  const ok = (presets, min) => tipAmountsProblem(presets, min) === null;
  assert.equal(ok([200000n, 500000n, 1000000n], 200000n), true);
  assert.equal(ok([100000n], 100000n), true);
  assert.equal(ok([], 200000n), false, 'at least one preset');
  assert.equal(
    ok([200000n, 300000n, 400000n, 500000n, 600000n], 200000n),
    false,
    'at most four',
  );
  assert.equal(ok([150000n], 200000n), false, 'below its own minimum');
  assert.equal(ok([200000n], 50000n), false, 'minimum under ₦1,000');
  assert.equal(ok([200050n], 200000n), false, 'whole naira only');
  assert.equal(ok([200000n], 200050n), false, 'minimum in whole naira');
  assert.equal(ok([200000n, 200000n], 200000n), false, 'no duplicates');
  assert.equal(ok([20000000n, 500000000n], 200000n), true, 'no maximum');
  assert.equal(
    ok([200000n], 50000000n),
    false,
    'presets below a large minimum',
  );
  assert.equal(ok([50000000n], 50000000n), true, 'a large minimum is fine');
});

test('a staff-set share replaces the 10% for one account; processing still comes out of it', async () => {
  const { priceTip, FEE_POLICY_V1 } = await import('../dist/index.js');
  // 8% of ₦5,000 = ₦400 to TipMe (₦75 processing inside it), ₦4,600 to the recipient.
  assert.deepEqual(priceTip(500000n, FEE_POLICY_V1, { shareBps: 800n }), {
    tipMinor: 500000n,
    platformFeeMinor: 32500n,
    providerFeeMinor: 7500n,
    payerTotalMinor: 500000n,
    recipientNetMinor: 460000n,
  });
  // 0%: the recipient receives everything and TipMe pays the processing itself.
  const free = priceTip(500000n, FEE_POLICY_V1, { shareBps: 0n });
  assert.equal(free.recipientNetMinor, 500000n);
  assert.equal(free.platformFeeMinor + free.providerFeeMinor, 0n);
  for (const shareBps of [-1n, 10001n])
    assert.throws(
      () => priceTip(500000n, FEE_POLICY_V1, { shareBps }),
      RangeError,
    );
});
