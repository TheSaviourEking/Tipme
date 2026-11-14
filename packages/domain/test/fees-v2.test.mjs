import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_FEE_POLICY,
  FEE_POLICY_V1,
  FEE_POLICY_V2_FREE,
  FEE_POLICY_V2_PRO,
  PROCESSING_INCLUDED_FEE_VERSIONS,
  feePolicyForPlan,
  planShareBps,
  priceTip,
} from '../dist/index.js';

// The owner's pricing, 12 Nov 2026: TipMe Free keeps 7% of each tip, TipMe Pro (₦5,000 a month)
// keeps 5%, processing included in both, for quotes created from the release that carries it.
// The recipient's plan at quote time picks the rate. Tips priced before keep their recorded 10%.

test('Free is 7% and Pro is 5%, processing still paid from TipMe’s share', () => {
  assert.equal(FEE_POLICY_V2_FREE.tipmeShareBps, 700n);
  assert.equal(FEE_POLICY_V2_PRO.tipmeShareBps, 500n);
  assert.equal(FEE_POLICY_V2_FREE.providerFeeBps, 150n);
  assert.equal(FEE_POLICY_V2_PRO.providerFeeBps, 150n);
  assert.equal(feePolicyForPlan('free'), FEE_POLICY_V2_FREE);
  assert.equal(feePolicyForPlan('pro'), FEE_POLICY_V2_PRO);
  // The standard (and the minimums every page shares) is the Free policy.
  assert.equal(CURRENT_FEE_POLICY, FEE_POLICY_V2_FREE);
  for (const policy of [FEE_POLICY_V2_FREE, FEE_POLICY_V2_PRO]) {
    assert.equal(policy.minTipMinor, 200_000n);
    assert.equal(policy.minWithdrawalMinor, 200_000n);
  }
});

test('each plan records its own version, never one that reads as V1 with a suffix', () => {
  const versions = [FEE_POLICY_V2_FREE.version, FEE_POLICY_V2_PRO.version];
  assert.equal(new Set([FEE_POLICY_V1.version, ...versions]).size, 3);
  for (const v of versions) {
    assert.equal(v.startsWith(`${FEE_POLICY_V1.version}-`), false, v);
    for (const other of versions)
      if (other !== v) assert.equal(v.startsWith(`${other}-`), false, v);
  }
});

test('a ₦5,000 tip: Free gives ₦4,650, Pro gives ₦4,750, V1 gave ₦4,500', () => {
  assert.deepEqual(priceTip(500000n, FEE_POLICY_V2_FREE), {
    tipMinor: 500000n,
    platformFeeMinor: 27500n,
    providerFeeMinor: 7500n,
    payerTotalMinor: 500000n,
    recipientNetMinor: 465000n,
  });
  assert.deepEqual(priceTip(500000n, FEE_POLICY_V2_PRO), {
    tipMinor: 500000n,
    platformFeeMinor: 17500n,
    providerFeeMinor: 7500n,
    payerTotalMinor: 500000n,
    recipientNetMinor: 475000n,
  });
  assert.equal(priceTip(500000n, FEE_POLICY_V1).recipientNetMinor, 450000n);
});

test('V1 is kept unchanged for history: 10%', () => {
  assert.equal(FEE_POLICY_V1.version, 'proposed-v1.1');
  assert.equal(FEE_POLICY_V1.tipmeShareBps, 1000n);
});

test('V1 and both V2 plans count as "processing included"', () => {
  assert.deepEqual(
    [...PROCESSING_INCLUDED_FEE_VERSIONS].sort(),
    [
      FEE_POLICY_V1.version,
      FEE_POLICY_V2_FREE.version,
      FEE_POLICY_V2_PRO.version,
    ].sort(),
  );
});

test('a staff-set share is capped at the plan’s rate; below it stays (owner, 12 Nov 2026)', () => {
  // No deal: the plan's rate.
  assert.deepEqual(planShareBps('free', null), { bps: 700n, custom: null });
  assert.deepEqual(planShareBps('pro', null), { bps: 500n, custom: null });
  // Above the plan's rate: the plan's rate, and the quote records no deal.
  assert.deepEqual(planShareBps('free', 1000n), { bps: 700n, custom: null });
  assert.deepEqual(planShareBps('pro', 600n), { bps: 500n, custom: null });
  assert.deepEqual(planShareBps('free', 700n), { bps: 700n, custom: null });
  // Below: the deal stands.
  assert.deepEqual(planShareBps('free', 600n), { bps: 600n, custom: 600n });
  assert.deepEqual(planShareBps('pro', 300n), { bps: 300n, custom: 300n });
  assert.deepEqual(planShareBps('pro', 0n), { bps: 0n, custom: 0n });
});

test('cash rewards stay half of the fees each tip really paid: old 10%, Free 7% and Pro 5% mixed', async () => {
  const { cashBonusAmount } = await import('../dist/index.js');
  // TipMe's share as recorded on each tip (platform + processing), from its own policy.
  const share = (b) => b.platformFeeMinor + b.providerFeeMinor;
  const fees =
    share(priceTip(1_000_000n, FEE_POLICY_V1)) + // ₦1,000
    share(priceTip(1_000_000n, FEE_POLICY_V2_FREE)) + // ₦700
    share(priceTip(1_000_000n, FEE_POLICY_V2_PRO)); // ₦500
  assert.equal(fees, 220_000n);
  assert.equal(
    cashBonusAmount({
      feesSinceLastCashMinor: fees,
      lifetimeFeesMinor: fees,
      lifetimeRewardCostMinor: 0n,
      budgetRemainingMinor: 10_000_000n,
    }),
    110_000n,
  );
});
