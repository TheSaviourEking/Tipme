import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as domain from '../dist/index.js';

// Paid Pro, plan Tasks 8 and 9: the balance and refund postings, and the refund's states.
const ADA = '0193f7a2-0000-7000-8000-00000000ada0';
const sum = (lines, account, side) =>
  lines
    .filter((l) => l.account === account && l.side === side)
    .reduce((t, l) => t + l.amountMinor, 0n);

test('a balance payment: recipient_payable −250000, subscription_revenue +250000, the money moves to TipMe’s own balance', () => {
  const lines = domain.buildProBalancePosting({
    amountMinor: 250000n,
    profileId: ADA,
  });
  assert.equal(domain.isBalanced(lines), true);
  assert.equal(sum(lines, 'recipient_payable', 'debit'), 250000n);
  assert.equal(
    lines.find((l) => l.account === 'recipient_payable').profileId,
    ADA,
  );
  assert.equal(sum(lines, 'subscription_revenue', 'credit'), 250000n);
  assert.equal(sum(lines, 'platform_clearing', 'debit'), 250000n);
  assert.equal(sum(lines, 'provider_clearing', 'credit'), 250000n);
  // Not a tip: no TipMe fee, nothing in platform_fee_revenue.
  assert.equal(
    lines.some((l) => l.account === 'platform_fee_revenue'),
    false,
  );
});

test('a balance payment of nothing, or without a person, throws', () => {
  assert.throws(() =>
    domain.buildProBalancePosting({ amountMinor: 0n, profileId: ADA }),
  );
  assert.throws(() =>
    domain.buildProBalancePosting({ amountMinor: 250000n, profileId: '' }),
  );
});

test('a paid refund gives back Pro revenue out of TipMe’s own balance; TipMe keeps the card fee and pays any refund fee', () => {
  const lines = domain.buildProRefundPosting({
    refundedMinor: 250000n,
    refundFeeMinor: 1000n,
    grossMinor: 250000n,
  });
  assert.equal(domain.isBalanced(lines), true);
  assert.equal(sum(lines, 'subscription_revenue', 'debit'), 250000n);
  assert.equal(sum(lines, 'provider_fee_expense', 'debit'), 1000n);
  assert.equal(sum(lines, 'platform_clearing', 'credit'), 251000n);
  const noFee = domain.buildProRefundPosting({
    refundedMinor: 250000n,
    refundFeeMinor: 0n,
    grossMinor: 250000n,
  });
  assert.equal(noFee.length, 2);
});

test('a refund above the sale, or of nothing, throws', () => {
  assert.throws(() =>
    domain.buildProRefundPosting({
      refundedMinor: 250001n,
      refundFeeMinor: 0n,
      grossMinor: 250000n,
    }),
  );
  assert.throws(() =>
    domain.buildProRefundPosting({
      refundedMinor: 0n,
      refundFeeMinor: 0n,
      grossMinor: 250000n,
    }),
  );
});

test('a refund is final once PAID or FAILED, and only the partner’s answer moves it on', () => {
  const t = domain.PRO_REFUND_TRANSITIONS;
  assert.equal(domain.canTransition(t, 'REQUESTED', 'PROCESSING'), true);
  assert.equal(domain.canTransition(t, 'PROCESSING', 'PAID'), true);
  assert.equal(domain.canTransition(t, 'PROCESSING', 'FAILED'), true);
  assert.equal(domain.canTransition(t, 'PAID', 'FAILED'), false);
  assert.equal(domain.canTransition(t, 'FAILED', 'PAID'), false);
});
