import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessMoneyState } from '../src/lib/business/money-state.ts';

// Business release 2, PR R2-B: what a business's Money section says and allows, from its quote.

const ready = (over = {}) => ({
  state: 'ready',
  withdrawableMinor: '1800000',
  ledgerMinor: '1800000',
  providerMinor: '1800000',
  feeMinor: '0',
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
