import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DEFAULT_PLAN_FEE_PERCENTS,
  WITHDRAWAL_FEE_COPY,
  FREE_SHARE_PERCENT,
  PRO_SHARE_PERCENT,
  planFeePercentsOf,
} from '../src/lib/fee-share.ts';

// The owner, 18 Nov 2026: Free 5% and Pro 3%, payment processing included (withdrawals cost ₦50,
// 25 Nov 2026), set in admin.
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

test('the copy says payment processing is included, and each withdrawal costs the partner fee', async () => {
  const { NGN_PAYOUT_FEE_MINOR } =
    await import('../../../packages/payments/src/payout-fee.ts');
  // The web app cannot import the payments package, so the copy's ₦50 is pinned to it here.
  assert.equal(
    WITHDRAWAL_FEE_COPY,
    `Each withdrawal costs ₦${NGN_PAYOUT_FEE_MINOR / 100n}, charged by our payment partner.`,
  );
  assert.equal(
    WITHDRAWAL_FEE_COPY,
    'Each withdrawal costs ₦50, charged by our payment partner.',
  );
  const home = await source('app/page.tsx');
  assert.match(home, /payment\s+processing/);
  assert.doesNotMatch(home, /withdrawal\s+fees/);
  const creators = await source('app/for-creators/page.tsx');
  assert.match(creators, /payment processing included/);
  assert.match(creators, /WITHDRAWAL_FEE_COPY/);
  assert.doesNotMatch(creators, /for free from|withdrawal fees/);
  const pro = await source('app/pro/page.tsx');
  assert.match(pro, /WITHDRAWAL_FEE_COPY/);
  assert.match(pro, /with payment processing included\./);
  assert.doesNotMatch(pro, /FREE_WITHDRAW|are free`|withdrawal fees/);
  // Free still keeps withdrawals to the bank: the line stays, with the fee instead of a free count.
  assert.match(
    pro,
    /`Withdrawals to your bank: \$\{formatNaira\(WITHDRAWAL_FEE_COPY_MINOR\)\} each, taken from the amount`/,
  );
  assert.doesNotMatch(
    await source('app/ops/pages/page.tsx'),
    /withdrawal fees/,
  );
  assert.match(await source('app/ops/pages/page.tsx'), /WITHDRAWAL_FEE_COPY/);
});

test('the Terms read the live rates and work the example nets from them', async () => {
  const terms = await source('app/legal/terms/page.tsx');
  assert.match(terms, /await getPlanFees\(\)/);
  assert.match(terms, /termsFeeFigures\(/);
  assert.doesNotMatch(terms, /FREE_SHARE_PERCENT|PRO_SHARE_PERCENT/);
  assert.doesNotMatch(terms, /feePolicyForPlan\('(free|pro)'\)/);
  assert.doesNotMatch(terms, /FEE_POLICY_V2/);
  // The ₦50 is rendered from the domain constant (pinned to the payout fee above), not written here.
  assert.match(
    terms,
    /Withdrawals:<\/strong>\s+each\s+withdrawal\s+costs\{' '\}\s+<Money\s+minor=\{Number\(WITHDRAWAL_FEE_COPY_MINOR\)\}\s+\/>,\s+charged\s+by\s+our\s+payment\s+partner,\s+and\s+comes\s+off\s+the\s+amount\./,
  );
  assert.doesNotMatch(terms, /₦50/);
  assert.doesNotMatch(terms, /FREE_WITHDRAW|are free|Withdrawals are free\./);
  assert.doesNotMatch(terms, /₦9,950|₦50<\/span> or less/);
  assert.match(terms, /payment processing/);
  // A business still pays the partner's transfer fee, and the Terms say so without naming it.
  assert.match(
    terms,
    /business’s balance still carry our\s+payment partner’s transfer fee/,
  );
});

test('the Terms follow a changed rate: percentages and example nets move together', async () => {
  const { termsFeeFigures } = await import('../src/lib/terms-fees.ts');
  // The starting rates: a ₦5,000 tip leaves ₦4,750 on Free, ₦4,850 on Pro; a ₦10,000 refund case
  // leaves ₦9,500 and ₦9,700.
  const start = termsFeeFigures(DEFAULT_PLAN_FEE_PERCENTS);
  assert.equal(start.exampleNet.free, 475000n);
  assert.equal(start.exampleNet.pro, 485000n);
  assert.equal(start.refundBack.free, 950000n);
  // Staff set 4.5% and 2.5%: a ₦5,000 tip leaves ₦4,775 and ₦4,875.
  const changed = termsFeeFigures({ freePercent: 4.5, proPercent: 2.5 });
  assert.equal(changed.freePercent, 4.5);
  assert.equal(changed.proPercent, 2.5);
  assert.equal(changed.exampleNet.free, 477500n);
  assert.equal(changed.exampleNet.pro, 487500n);
  assert.equal(changed.refundBack.free, 955000n);
  assert.equal(changed.refundBack.pro, 975000n);
});
