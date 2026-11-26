import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_FEE_POLICY,
  DEFAULT_PLAN_FEE_RATES,
  PLAN_FEE_MAX_BPS,
  PLAN_FEE_MIN_BPS,
  FEE_POLICY_V1,
  FEE_POLICY_V2_FREE,
  FEE_POLICY_V2_PRO,
  PROCESSING_INCLUDED_FEE_VERSIONS,
  feePolicyForPlan,
  planFeeRatesProblem,
  lagosDayStart,
  planShareBps,
  priceTip,
} from '../dist/index.js';

// The owner, 18 Nov 2026: Free 5% and Pro 3% per tip, processing (and withdrawals) included, and the
// two rates are an admin setting. These are the coded defaults; the setting overrides them.

const share = (b) => b.platformFeeMinor + b.providerFeeMinor;

test('the coded defaults are Free 5% and Pro 3%', () => {
  assert.deepEqual(DEFAULT_PLAN_FEE_RATES, { freeBps: 500n, proBps: 300n });
  assert.equal(feePolicyForPlan('free').tipmeShareBps, 500n);
  assert.equal(feePolicyForPlan('pro').tipmeShareBps, 300n);
  assert.equal(CURRENT_FEE_POLICY.tipmeShareBps, 500n);
  for (const plan of ['free', 'pro']) {
    assert.equal(feePolicyForPlan(plan).providerFeeBps, 150n);
    assert.equal(feePolicyForPlan(plan).minTipMinor, 200_000n);
  }
});

test('a ₦10,000 tip with the defaults: Free keeps ₦500, Pro ₦300; the supporter pays the tip only', () => {
  const free = priceTip(1_000_000n, feePolicyForPlan('free'));
  assert.equal(share(free), 50_000n);
  assert.equal(free.providerFeeMinor, 15_000n);
  assert.equal(free.payerTotalMinor, 1_000_000n);
  assert.equal(free.recipientNetMinor, 950_000n);
  const pro = priceTip(1_000_000n, feePolicyForPlan('pro'));
  assert.equal(share(pro), 30_000n);
  assert.equal(pro.providerFeeMinor, 15_000n);
  assert.equal(pro.payerTotalMinor, 1_000_000n);
  assert.equal(pro.recipientNetMinor, 970_000n);
});

test('processing is inside TipMe’s share: nobody pays a separate processing amount', () => {
  for (const plan of ['free', 'pro'])
    for (const tip of [200_000n, 500_000n, 1_234_500n, 100_000_000n]) {
      const b = priceTip(tip, feePolicyForPlan(plan));
      // The supporter pays exactly the tip; the recipient loses only the plan's share.
      assert.equal(b.payerTotalMinor, tip);
      assert.equal(b.recipientNetMinor + share(b), tip);
      const bps = feePolicyForPlan(plan).tipmeShareBps;
      assert.equal(share(b), (tip * bps + 5000n) / 10000n);
    }
});

test('the setting overrides the defaults, and the version names the rate it used', () => {
  const rates = { freeBps: 450n, proBps: 250n };
  const free = feePolicyForPlan('free', rates);
  const pro = feePolicyForPlan('pro', rates);
  assert.equal(free.tipmeShareBps, 450n);
  assert.equal(pro.tipmeShareBps, 250n);
  assert.equal(free.version, 'v3-free-450bps');
  assert.equal(pro.version, 'v3-pro-250bps');
  assert.equal(feePolicyForPlan('free').version, 'v3-free-500bps');
  assert.equal(feePolicyForPlan('pro').version, 'v3-pro-300bps');
  assert.equal(share(priceTip(1_000_000n, free)), 45_000n);
  assert.equal(share(priceTip(1_000_000n, pro)), 25_000n);
});

test('a staff-set per-account fee still wins below the plan rate, from the setting too', () => {
  assert.deepEqual(planShareBps('free', null), { bps: 500n, custom: null });
  assert.deepEqual(planShareBps('pro', null), { bps: 300n, custom: null });
  // At or above the plan's rate: the plan's rate, no deal recorded.
  assert.deepEqual(planShareBps('free', 600n), { bps: 500n, custom: null });
  assert.deepEqual(planShareBps('pro', 300n), { bps: 300n, custom: null });
  // Below: the deal stands.
  assert.deepEqual(planShareBps('free', 400n), { bps: 400n, custom: 400n });
  assert.deepEqual(planShareBps('pro', 0n), { bps: 0n, custom: 0n });
  // With a setting, the cap is the set rate.
  const rates = { freeBps: 800n, proBps: 600n };
  assert.deepEqual(planShareBps('free', 700n, rates), {
    bps: 700n,
    custom: 700n,
  });
  assert.deepEqual(planShareBps('pro', 700n, rates), {
    bps: 600n,
    custom: null,
  });
});

test('each rate must be from 150 to 1000 basis points (1.5% to 10%), and Pro never above Free', () => {
  assert.equal(PLAN_FEE_MIN_BPS, 150n);
  assert.equal(PLAN_FEE_MAX_BPS, 1000n);
  assert.equal(planFeeRatesProblem({ freeBps: 500n, proBps: 300n }), null);
  assert.equal(planFeeRatesProblem({ freeBps: 150n, proBps: 150n }), null);
  assert.equal(planFeeRatesProblem({ freeBps: 1000n, proBps: 1000n }), null);
  assert.equal(planFeeRatesProblem({ freeBps: 500n, proBps: 500n }), null);
  assert.equal(planFeeRatesProblem({ freeBps: 149n, proBps: 149n }), 'freeBps');
  assert.equal(planFeeRatesProblem({ freeBps: 0n, proBps: 0n }), 'freeBps');
  assert.equal(
    planFeeRatesProblem({ freeBps: 1001n, proBps: 300n }),
    'freeBps',
  );
  assert.equal(planFeeRatesProblem({ freeBps: 500n, proBps: 149n }), 'proBps');
  assert.equal(
    planFeeRatesProblem({ freeBps: 1000n, proBps: 1001n }),
    'proBps',
  );
  assert.equal(
    planFeeRatesProblem({ freeBps: 300n, proBps: 500n }),
    'proAboveFree',
  );
  // A rate that is out of bounds is refused before the Pro-above-Free rule.
  assert.throws(() =>
    feePolicyForPlan('free', { freeBps: 20000n, proBps: 300n }),
  );
});

test('V3 versions count as "processing included"; V1 and V2 stay for history', () => {
  const included = (recorded) =>
    PROCESSING_INCLUDED_FEE_VERSIONS.some(
      (v) => recorded === v || recorded.startsWith(`${v}-`),
    );
  for (const recorded of [
    'v3-free-500bps',
    'v3-pro-300bps',
    'v3-free-500bps-custom-400',
    'v3-pro-300bps-fee-free',
    FEE_POLICY_V1.version,
    FEE_POLICY_V2_FREE.version,
    FEE_POLICY_V2_PRO.version,
  ])
    assert.ok(included(recorded), recorded);
  assert.equal(FEE_POLICY_V2_FREE.tipmeShareBps, 700n);
  assert.equal(FEE_POLICY_V2_PRO.tipmeShareBps, 500n);
});

test('a Lagos calendar day starts at 23:00 UTC the evening before', () => {
  const start = (iso) => lagosDayStart(new Date(iso)).toISOString();
  assert.equal(start('2026-11-18T12:00:00Z'), '2026-11-17T23:00:00.000Z');
  assert.equal(start('2026-11-18T22:59:59.999Z'), '2026-11-17T23:00:00.000Z');
  assert.equal(start('2026-11-18T23:00:00Z'), '2026-11-18T23:00:00.000Z');
  assert.equal(start('2026-11-18T00:30:00Z'), '2026-11-17T23:00:00.000Z');
});
