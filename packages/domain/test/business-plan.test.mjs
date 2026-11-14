import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUSINESS_LIMITS,
  BUSINESS_NAME_CHANGES_PER_YEAR,
  BUSINESS_OWNER_LIMIT,
  BUSINESS_PRO_REMINDER_DAYS,
  buildBusinessProBalancePosting,
  businessLimits,
  isBalanced,
} from '../dist/index.js';

// Business Pro, plan Task A2 (owner, 14 Nov 2026): the limits and the balance posting.

test('business limits', () => {
  assert.deepEqual(businessLimits('free'), { staff: 3, locations: 1 });
  assert.deepEqual(businessLimits('pro'), { staff: 25, locations: 25 });
  assert.deepEqual(BUSINESS_LIMITS.pro, { staff: 25, locations: 25 });
  // A copy: a caller can't change the shared limits.
  businessLimits('free').staff = 99;
  assert.equal(businessLimits('free').staff, 3);
});

test('the other Business Pro numbers', () => {
  assert.equal(BUSINESS_OWNER_LIMIT, 3);
  assert.equal(BUSINESS_NAME_CHANGES_PER_YEAR, 3);
  assert.equal(BUSINESS_PRO_REMINDER_DAYS, 7);
});

test('a Business Pro balance payment takes the business payable', () => {
  const lines = buildBusinessProBalancePosting({
    amountMinor: 700000n,
    businessId: 'b1',
  });
  assert.deepEqual(lines, [
    {
      account: 'business_payable',
      side: 'debit',
      amountMinor: 700000n,
      businessId: 'b1',
    },
    { account: 'subscription_revenue', side: 'credit', amountMinor: 700000n },
    { account: 'platform_clearing', side: 'debit', amountMinor: 700000n },
    { account: 'provider_clearing', side: 'credit', amountMinor: 700000n },
  ]);
  assert.ok(isBalanced(lines));
  assert.throws(
    () => buildBusinessProBalancePosting({ amountMinor: 0n, businessId: 'b1' }),
    RangeError,
  );
  assert.throws(
    () => buildBusinessProBalancePosting({ amountMinor: 1n, businessId: '' }),
    RangeError,
  );
});
