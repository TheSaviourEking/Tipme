import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_FEE_POLICY,
  belowWithdrawalMinimum,
  userPaidWithdrawal,
  withdrawalMinimumMinor,
} from '../dist/index.js';

// Owner, 14 Nov 2026: the smallest personal withdrawal is the system's smallest tip, read from the
// fee policy's minTipMinor, so the two can never drift. The ₦50 fee still comes off the amount.

test('the withdrawal minimum is the policy’s minimum tip: ₦2,000 today', () => {
  assert.equal(withdrawalMinimumMinor(), CURRENT_FEE_POLICY.minTipMinor);
  assert.equal(withdrawalMinimumMinor(), 200_000n);
  assert.equal('minWithdrawalMinor' in CURRENT_FEE_POLICY, false);
});

test('change minTipMinor in a policy and the withdrawal minimum follows', () => {
  const policy = { ...CURRENT_FEE_POLICY, minTipMinor: 350_000n };
  assert.equal(withdrawalMinimumMinor(policy), 350_000n);
  // ₦3,000 of ₦10,000 is now too small; ₦3,500 is not.
  assert.equal(belowWithdrawalMinimum(300_000n, 1_000_000n, policy), true);
  assert.equal(belowWithdrawalMinimum(350_000n, 1_000_000n, policy), false);
  // Under the standard policy ₦3,000 is fine.
  assert.equal(belowWithdrawalMinimum(300_000n, 1_000_000n), false);
});

test('Everything is always allowed below the minimum, and ₦50 or less still sends nothing', () => {
  const policy = { ...CURRENT_FEE_POLICY, minTipMinor: 350_000n };
  // The whole of what can go, under the minimum: allowed.
  assert.equal(belowWithdrawalMinimum(180_000n, 180_000n, policy), false);
  assert.equal(belowWithdrawalMinimum(180_000n, 180_000n), false);
  // Part of it, under the minimum: refused.
  assert.equal(belowWithdrawalMinimum(150_000n, 180_000n), true);
  // A balance of ₦50 or less is refused by the fee rule, whatever the minimum.
  assert.equal(
    userPaidWithdrawal({ chosenMinor: 5_000n, feeMinor: 5_000n }),
    null,
  );
});
