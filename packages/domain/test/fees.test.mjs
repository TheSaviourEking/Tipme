import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AmountOutOfRangeError,
  FEE_POLICY_V1,
  priceTip,
  STANDARD_TIP_PRESETS_MINOR,
} from '../dist/index.js';

// FEE_POLICY_V1 (history since 12 Nov 2026; fees-v2.test.mjs has the current 5%): TipMe kept 10% of the tip
// and pays the processing fee out of that share; the recipient receives 90%.

const parts = (b) =>
  b.platformFeeMinor + b.providerFeeMinor + b.recipientNetMinor;

test('the PRD example: a ₦5,000 tip gives ₦500 to TipMe (processing included) and ₦4,500 to the recipient', () => {
  assert.equal(FEE_POLICY_V1.version, 'proposed-v1.1');
  const quote = priceTip(500000n, FEE_POLICY_V1);
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
    200000n,
    200001n,
    223457n,
    999999n,
    10_000_000n,
    999_999_999_999n,
  ]) {
    const quote = priceTip(tip, FEE_POLICY_V1);
    assert.equal(parts(quote), tip, String(tip));
    assert.ok(quote.platformFeeMinor >= 0n);
    assert.equal(quote.recipientNetMinor, tip - (tip * 1000n + 5000n) / 10000n);
  }
});

test('tips below ₦2,000 are refused; there is no maximum: supporters tip what they want', () => {
  assert.throws(() => priceTip(199999n, FEE_POLICY_V1), AmountOutOfRangeError);
  assert.equal(
    priceTip(10_000_001n, FEE_POLICY_V1).recipientNetMinor,
    9_000_001n,
  );
  assert.equal(
    priceTip(500_000_000_00n, FEE_POLICY_V1).recipientNetMinor,
    450_000_000_00n,
  );
  assert.equal('maxTipMinor' in FEE_POLICY_V1, false);
  assert.equal(FEE_POLICY_V1.minTipMinor, 200000n);
  assert.equal(FEE_POLICY_V1.minWithdrawalMinor, 200000n);
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
    'a page minimum below ₦2,000 does not lower the floor',
  );
});

test('a Pro page’s amounts: 1–4 unique presets in whole naira, each at least its minimum (no maximum); minimum at least ₦1,000', async () => {
  const { tipAmountsProblem } = await import('../dist/index.js');
  const ok = (presets, min) => tipAmountsProblem(presets, min) === null;
  assert.equal(ok([200000n, 500000n, 1000000n], 200000n), true);
  assert.equal(ok([200000n], 200000n), true);
  assert.equal(ok([], 200000n), false, 'at least one preset');
  assert.equal(
    ok([200000n, 300000n, 400000n, 500000n, 600000n], 200000n),
    false,
    'at most four',
  );
  assert.equal(ok([150000n], 200000n), false, 'below its own minimum');
  assert.equal(ok([200000n], 50000n), false, 'minimum under ₦2,000');
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

// Owner decision, 2 Nov 2026: the supporter sees only "Tip ₦2,000". That is honest only because the
// charge is exactly the tip on every path, so this must fail loudly if it ever stops being true.
test('the supporter’s charge equals the tip on every path: normal, fee-free and any staff-set share', () => {
  const tips = [
    200000n,
    200001n,
    223457n,
    250000n,
    999999n,
    10_000_000n,
    999_999_999_999n,
  ];
  const options = [
    {},
    { feeFree: true },
    { minTipMinor: 200000n },
    { feeFree: true, minTipMinor: 200000n },
    ...[0n, 1n, 100n, 800n, 1000n, 2500n, 9999n, 10000n].map((shareBps) => ({
      shareBps,
    })),
    { feeFree: true, shareBps: 800n },
  ];
  for (const tip of tips)
    for (const option of options) {
      const priced = priceTip(tip, FEE_POLICY_V1, option);
      assert.equal(priced.payerTotalMinor, tip);
      assert.equal(priced.tipMinor, tip);
      assert.equal(
        priced.recipientNetMinor +
          priced.platformFeeMinor +
          priced.providerFeeMinor,
        tip,
      );
    }
});

test('the smallest tip and the smallest withdrawal are both ₦2,000 (owner, 2 Nov 2026)', () => {
  assert.equal(FEE_POLICY_V1.minTipMinor, 200_000n);
  assert.equal(FEE_POLICY_V1.minWithdrawalMinor, 200_000n);
  assert.throws(() => priceTip(199_900n, FEE_POLICY_V1), AmountOutOfRangeError);
  assert.equal(priceTip(200_000n, FEE_POLICY_V1).recipientNetMinor, 180_000n);
});

test('the standard amounts all clear the minimum', () => {
  assert.deepEqual(STANDARD_TIP_PRESETS_MINOR, [
    200_000n,
    500_000n,
    1_000_000n,
  ]);
});

test("tipStartAllowed: only one of the page's own presets", async () => {
  const { tipStartAllowed } = await import('../dist/index.js');
  const presets = [500000n, 1000000n, 2000000n];
  assert.equal(tipStartAllowed(presets, 1000000n), true);
  assert.equal(tipStartAllowed(presets, 500000n), true);
  assert.equal(tipStartAllowed(presets, 300000n), false, 'not one of them');
  assert.equal(tipStartAllowed([], 1000000n), false, 'no presets');
});
