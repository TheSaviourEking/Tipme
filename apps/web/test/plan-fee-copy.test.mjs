import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DEFAULT_PLAN_FEE_PERCENTS,
  FREE_SHARE_PERCENT,
  PRO_SHARE_PERCENT,
  planFeePercentsOf,
} from '../src/lib/fee-share.ts';

// The owner, 18 Nov 2026: Free 5% and Pro 3%, payment and withdrawal fees included, set in admin.
// Copy reads the live setting; only fixed text (the Terms) states the starting numbers.

const source = (path) =>
  readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the starting rates are 5% on Free and 3% on Pro', () => {
  assert.equal(FREE_SHARE_PERCENT, 5);
  assert.equal(PRO_SHARE_PERCENT, 3);
  assert.deepEqual(DEFAULT_PLAN_FEE_PERCENTS, {
    freePercent: 5,
    proPercent: 3,
  });
});

test('the live rates are read from the API answer, and a bad answer is refused', () => {
  assert.deepEqual(planFeePercentsOf({ freeBps: 500, proBps: 300 }), {
    freePercent: 5,
    proPercent: 3,
  });
  assert.deepEqual(planFeePercentsOf({ freeBps: 450, proBps: 250 }), {
    freePercent: 4.5,
    proPercent: 2.5,
  });
  for (const bad of [
    null,
    {},
    { freeBps: '500', proBps: 300 },
    { freeBps: 300, proBps: 500 },
    { freeBps: 10001, proBps: 0 },
    { freeBps: -1, proBps: 0 },
    { freeBps: 4.5, proBps: 0 },
  ])
    assert.equal(planFeePercentsOf(bad), null, JSON.stringify(bad));
});

test('the home, creators, Pro, settings and ops copy read the live rates, never the old constants', async () => {
  const live = {
    'app/page.tsx':
      /<PlanFeePercent plan="free" \/>%[\s\S]*<PlanFeePercent plan="pro" \/>%/,
    'app/for-creators/page.tsx': /<PlanFeePercent plan="free" \/>%/,
    'app/pro/page.tsx': /await getPlanFees\(\)/,
    'app/dashboard/settings/sections/plan.tsx': /usePlanFees\(\)/,
    'app/ops/pages/page.tsx': /usePlanFees\(\)/,
  };
  for (const [path, pattern] of Object.entries(live)) {
    const src = await source(path);
    assert.match(src, pattern, path);
    assert.doesNotMatch(src, /FREE_SHARE_PERCENT|PRO_SHARE_PERCENT/, path);
    assert.doesNotMatch(src, /\b7%|FEE_POLICY_V2/, path);
  }
});

test('the copy says payment and withdrawal fees are included, and withdrawals are free', async () => {
  assert.match(
    await source('app/page.tsx'),
    /payment\s+and\s+withdrawal\s+fees/,
  );
  assert.match(
    await source('app/for-creators/page.tsx'),
    /payment and withdrawal fees included/,
  );
  const pro = await source('app/pro/page.tsx');
  assert.match(pro, /Withdrawals are free on both plans/);
  assert.match(pro, /Free withdrawals to your bank/);
});

test('the Terms state 5% and 3% and free withdrawals, from the starting rates', async () => {
  const terms = await source('app/legal/terms/page.tsx');
  assert.match(terms, /feePolicyForPlan\('free'\)/);
  assert.match(terms, /feePolicyForPlan\('pro'\)/);
  assert.match(terms, /FREE_SHARE_PERCENT/);
  assert.doesNotMatch(terms, /FEE_POLICY_V2/);
  assert.match(terms, /Withdrawals are free/);
  assert.doesNotMatch(terms, /₦9,950|₦50<\/span> or less/);
  // A ₦5,000 tip at the starting rates: ₦4,750 on Free, ₦4,850 on Pro.
  const { feePolicyForPlan, priceTip } = await import('@tipme/domain');
  assert.equal(
    priceTip(500000n, feePolicyForPlan('free')).recipientNetMinor,
    475000n,
  );
  assert.equal(
    priceTip(500000n, feePolicyForPlan('pro')).recipientNetMinor,
    485000n,
  );
});
