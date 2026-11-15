import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessCanSend,
  businessMoneyState,
} from '../src/lib/business/money-state.ts';

// Business release 2, PR R2-B: what a business's Money section says and allows, from its quote.

const ready = (over = {}) => ({
  state: 'ready',
  withdrawableMinor: '1800000',
  ledgerMinor: '1800000',
  providerMinor: '1800000',
  feeMinor: '0',
  feePaidBy: 'user',
  destination: { bankName: 'Pretend Guaranty Bank', last4: '6789' },
  inReview: false,
  ...over,
});

test('ready: the owner can withdraw up to what the quote allows, to the business’s bank', () => {
  const state = businessMoneyState(ready());
  assert.equal(state.canWithdraw, true);
  assert.equal(state.withdrawableMinor, 1800000n);
  assert.match(state.notice.body, /Pretend Guaranty Bank ••6789/);
});

test('below zero after a reversal, or paused, nothing can be withdrawn and it says why', () => {
  const below = businessMoneyState({
    state: 'paused',
    reason: 'reversal',
    inReview: false,
  });
  assert.equal(below.canWithdraw, false);
  assert.equal(below.withdrawableMinor, 0n);
  assert.match(below.notice.body, /refund|chargeback/i);
  const off = businessMoneyState({
    state: 'paused',
    reason: 'switched_off',
    inReview: false,
  });
  assert.equal(off.canWithdraw, false);
  assert.match(off.notice.body, /paused/);
});

test('no bank yet points at the bank card; no quote is never a yes', () => {
  const none = businessMoneyState({ state: 'no_destination', inReview: false });
  assert.equal(none.canWithdraw, false);
  assert.equal(none.notice.href, '#business-bank');
  for (const quote of [
    null,
    { state: 'provider_unavailable', inReview: false },
  ])
    assert.equal(businessMoneyState(quote).canWithdraw, false);
  const nothing = businessMoneyState(
    ready({ withdrawableMinor: '0', ledgerMinor: '0' }),
  );
  assert.equal(nothing.canWithdraw, false);
});

test('copy never names the payment provider or implies approval', () => {
  const states = [
    ready(),
    { state: 'paused', reason: 'reversal', inReview: false },
    { state: 'paused', reason: 'review', inReview: false },
    { state: 'setup_needed', requirementsDue: [], inReview: false },
    { state: 'destination_pending', inReview: false },
    null,
  ];
  for (const quote of states) {
    const { notice } = businessMoneyState(quote);
    assert.doesNotMatch(
      `${notice.title} ${notice.body}`,
      /bachs|licen[cs]ed|approved/i,
    );
  }
});

// Option B: a business sets up its own payout account with our payment partner, and withdraws in
// batches of at least the business minimum, or everything it has (owner, 12 Nov 2026: the business
// pays the ₦50 transfer fee from the amount, so taking everything costs TipMe nothing).
test('setup needed asks the owner to set up the business’s payout account', () => {
  const { notice, canWithdraw } = businessMoneyState({
    state: 'setup_needed',
    requirementsDue: [],
    inReview: false,
  });
  assert.equal(canWithdraw, false);
  assert.equal(notice.title, 'Set up the business’s payout account');
  assert.match(notice.body, /our payment partner/);
});

test('a business may send from its minimum up to what it can withdraw, or everything it has', () => {
  // The minimum is the minimum tip, ₦2,000 (owner, 14 Nov 2026), from the shared rule.
  const fee = BigInt(5000);
  assert.equal(businessCanSend(BigInt(199999), BigInt(600000), fee), false);
  assert.equal(businessCanSend(BigInt(200000), BigInt(600000), fee), true);
  assert.equal(businessCanSend(BigInt(600001), BigInt(600000), fee), false);
  assert.equal(businessCanSend(BigInt(0), BigInt(600000), fee), false);
  // Everything, though under the minimum: allowed again now the business pays the fee.
  assert.equal(businessCanSend(BigInt(199999), BigInt(199999), fee), true);
  assert.equal(businessCanSend(BigInt(5001), BigInt(5001), fee), true);
  // Not more than the fee: nothing would arrive.
  assert.equal(businessCanSend(BigInt(5000), BigInt(5000), fee), false);
});

test('a balance not more than the ₦50 fee can’t be withdrawn, and it says why in plain words', () => {
  for (const withdrawableMinor of ['5000', '1200']) {
    const state = businessMoneyState(
      ready({
        withdrawableMinor,
        ledgerMinor: withdrawableMinor,
        feeMinor: '5000',
      }),
    );
    assert.equal(state.canWithdraw, false);
    assert.equal(state.withdrawableMinor, 0n);
    assert.match(state.notice.body, /₦50 transfer fee/);
    assert.match(state.notice.body, /stays in the business’s balance/);
    assert.doesNotMatch(
      `${state.notice.title} ${state.notice.body}`,
      /bachs|WITHDRAWAL_BELOW_FEE/i,
    );
  }
  // Just above the fee: the owner can take it all.
  const above = businessMoneyState(
    ready({ withdrawableMinor: '5001', ledgerMinor: '5001', feeMinor: '5000' }),
  );
  assert.equal(above.canWithdraw, true);
});

test('the business’s ready notice says the fee comes off the amount, never that TipMe pays', () => {
  const state = businessMoneyState(ready({ feeMinor: '5000' }));
  assert.match(state.notice.body, /₦50 transfer fee comes off/);
  assert.doesNotMatch(state.notice.body, /TipMe pays/);
});
