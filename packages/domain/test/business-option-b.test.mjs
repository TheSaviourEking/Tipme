import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_FEE_POLICY,
  withdrawalMinimumMinor,
  allocateHoldbacks,
  buildPaymentPosting,
  buildReversalPosting,
  refundMoves,
  splitShare,
} from '../dist/index.js';

// Business release 2 on option B (owner, 11 Nov 2026): the arithmetic of moving a share between
// partner accounts, and of putting a refunded shared tip right. All in kobo, never floats.

const PERSON = '00000000-0000-7000-8000-0000000000aa';
const FIRM = '00000000-0000-7000-8000-0000000000bb';

test('the sandbox tip: ₦10,000 with TipMe’s 10% leaves ₦9,000; 80/20 gives the business exactly ₦1,800', () => {
  assert.deepEqual(splitShare(900000n, 2000), {
    personMinor: 720000n,
    businessMinor: 180000n,
  });
  // An odd net: the share is rounded down, so the remainder kobo stays with the person.
  assert.deepEqual(splitShare(900001n, 3000), {
    personMinor: 630001n,
    businessMinor: 270000n,
  });
});

// Owner, 14 Nov 2026: a business's smallest withdrawal is the system's minimum tip, the shared rule
// a person's withdrawals use (withdrawalMinimumMinor / belowWithdrawalMinimum, tested there).
test('a business withdraws at least the fee policy’s minimum tip', () => {
  assert.equal(withdrawalMinimumMinor(), CURRENT_FEE_POLICY.minTipMinor);
  assert.equal(withdrawalMinimumMinor(), 200000n);
});

test('a sweep with nothing held back delivers the whole share', () => {
  assert.deepEqual(allocateHoldbacks(180000n, []), {
    deliverMinor: 180000n,
    repay: [],
  });
});

test('hold-backs are paid oldest first, never more than the share, never more than each one owes', () => {
  assert.deepEqual(
    allocateHoldbacks(180000n, [
      { id: 'a', remainingMinor: 50000n },
      { id: 'b', remainingMinor: 200000n },
      { id: 'c', remainingMinor: 10000n },
    ]),
    {
      deliverMinor: 0n,
      repay: [
        { id: 'a', amountMinor: 50000n },
        { id: 'b', amountMinor: 130000n },
      ],
    },
  );
  assert.deepEqual(
    allocateHoldbacks(180000n, [{ id: 'a', remainingMinor: 30001n }]),
    { deliverMinor: 149999n, repay: [{ id: 'a', amountMinor: 30001n }] },
  );
  assert.throws(() => allocateHoldbacks(0n, []), RangeError);
});

/** The sandbox tip as TipMe books it: gross ₦10,000, fee ₦1,000, 80/20 of the ₦9,000 net. */
const payment = buildPaymentPosting({
  grossMinor: 1000000n,
  platformFeeMinor: 100000n,
  quotedProviderFeeMinor: 0n,
  actualProviderFeeMinor: 20000n,
  recipientNetMinor: 900000n,
  profileId: PERSON,
  businessShare: { businessId: FIRM, amountMinor: 180000n },
});

test('a full refund: TipMe returns its whole ₦1,000 fee and the business owes back its ₦1,800', () => {
  const reversal = buildReversalPosting(payment, { refundedMinor: 1000000n });
  assert.deepEqual(refundMoves(reversal, { businessId: FIRM }), {
    feeReturnMinor: 100000n,
    businessBackMinor: 180000n,
  });
});

test('a partial refund returns each part in the same proportion as the ledger takes it', () => {
  const reversal = buildReversalPosting(payment, { refundedMinor: 250000n });
  const moves = refundMoves(reversal, { businessId: FIRM });
  assert.deepEqual(moves, {
    feeReturnMinor: 25000n,
    businessBackMinor: 45000n,
  });
  // What the partner takes from the staff member (the refund) is exactly their own part, plus
  // what TipMe and the business give back.
  const personPart = reversal
    .filter((l) => l.account === 'recipient_payable')
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  assert.equal(
    personPart + moves.feeReturnMinor + moves.businessBackMinor,
    250000n,
  );
});

test('a refund with a fee of its own: that fee is TipMe’s cost, never sent to anyone', () => {
  const reversal = buildReversalPosting(payment, {
    refundedMinor: 1000000n,
    refundFeeMinor: 5000n,
  });
  assert.deepEqual(refundMoves(reversal, { businessId: FIRM }), {
    feeReturnMinor: 100000n,
    businessBackMinor: 180000n,
  });
});
