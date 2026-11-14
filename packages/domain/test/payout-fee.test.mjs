import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPayoutFeePosting,
  buildUserPayoutFeePosting,
  userPaidWithdrawal,
} from '../dist/index.js';

// Users pay their own withdrawal fee, taken from the amount (owner, 12 Nov 2026): withdraw ₦10,000
// and ₦9,950 arrives; the partner's ₦50 comes off what was chosen.

test('withdraw ₦10,000: ₦9,950 is sent, ₦50 is the fee, ₦10,000 leaves the balance', () => {
  assert.deepEqual(
    userPaidWithdrawal({ chosenMinor: 1_000_000n, feeMinor: 5_000n }),
    { sendMinor: 995_000n, feeMinor: 5_000n, leavesBalanceMinor: 1_000_000n },
  );
});

test('a balance of ₦50 or less can never be withdrawn: nothing would arrive', () => {
  assert.equal(
    userPaidWithdrawal({ chosenMinor: 5_000n, feeMinor: 5_000n }),
    null,
  );
  assert.equal(
    userPaidWithdrawal({ chosenMinor: 4_000n, feeMinor: 5_000n }),
    null,
  );
  assert.deepEqual(
    userPaidWithdrawal({ chosenMinor: 5_001n, feeMinor: 5_000n }),
    {
      sendMinor: 1n,
      feeMinor: 5_000n,
      leavesBalanceMinor: 5_001n,
    },
  );
});

test('with no fee, all of it is sent', () => {
  assert.deepEqual(
    userPaidWithdrawal({ chosenMinor: 200_000n, feeMinor: 0n }),
    {
      sendMinor: 200_000n,
      feeMinor: 0n,
      leavesBalanceMinor: 200_000n,
    },
  );
});

test('the user’s fee is booked against their own balance, never as TipMe’s expense', () => {
  const person = buildUserPayoutFeePosting({
    feeMinor: 5_000n,
    profileId: 'p1',
  });
  assert.deepEqual(
    person.map((l) => [
      l.account,
      l.side,
      l.amountMinor,
      l.profileId ?? l.businessId ?? null,
    ]),
    [
      ['recipient_payable', 'debit', 5_000n, 'p1'],
      ['provider_clearing', 'credit', 5_000n, null],
    ],
  );
  const business = buildUserPayoutFeePosting({
    feeMinor: 5_000n,
    businessId: 'b1',
  });
  assert.equal(business[0].account, 'business_payable');
  assert.equal(business[0].businessId, 'b1');
  assert.throws(() =>
    buildUserPayoutFeePosting({ feeMinor: 0n, profileId: 'p1' }),
  );
  // TipMe's own fee posting (old rule, and anything above ₦50 it absorbs) is unchanged.
  assert.equal(
    buildPayoutFeePosting({ feeMinor: 2_000n })[0].account,
    'provider_fee_expense',
  );
});

test('a partner fee under what was taken is credited back to the same payable (owner, 14 Nov 2026)', async () => {
  const { buildUserPayoutFeeRefundPosting } = await import('../dist/index.js');
  const person = buildUserPayoutFeeRefundPosting({
    feeMinor: 2_000n,
    profileId: 'p1',
  });
  assert.deepEqual(
    person.map((l) => [
      l.account,
      l.side,
      l.amountMinor,
      l.profileId ?? l.businessId ?? null,
    ]),
    [
      ['recipient_payable', 'credit', 2_000n, 'p1'],
      ['provider_clearing', 'debit', 2_000n, null],
    ],
  );
  const business = buildUserPayoutFeeRefundPosting({
    feeMinor: 2_000n,
    businessId: 'b1',
  });
  assert.equal(business[0].account, 'business_payable');
  assert.throws(() =>
    buildUserPayoutFeeRefundPosting({ feeMinor: 0n, profileId: 'p1' }),
  );
});
