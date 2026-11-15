import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  proPaymentMethodWords,
  proRefundOffer,
  proRefundStateWords,
} from '../src/lib/pro-payment-view.ts';
import { tipReverseView } from '../src/lib/tip-reverse-view.ts';

// Admin money screens (16 Nov 2026): a page's Pro payments with a reasoned refund, and taking back
// a refunded or charged-back tip from its issue. These decide what each screen offers; the API
// decides again (the `pro_refunds` switch, `pro.refund`, `tip.reverse`).

const payment = (over = {}) => ({
  purchaseId: '00000000-0000-4000-8000-000000000001',
  amountMinor: '500000',
  currency: 'NGN',
  paidAt: '2026-11-10T09:00:00.000Z',
  paidBy: 'card',
  refundable: true,
  words: 'This card payment can be refunded.',
  refund: null,
  period: {
    startsAt: '2026-11-10T09:00:00.000Z',
    endsAt: '2026-12-10T09:00:00.000Z',
  },
  ...over,
});

test('each way of paying for Pro has plain words, never the partner’s name', () => {
  assert.equal(proPaymentMethodWords('card'), 'Card');
  assert.equal(proPaymentMethodWords('saved_card'), 'Saved card (auto-renew)');
  assert.equal(proPaymentMethodWords('bank_transfer'), 'Bank transfer');
  assert.equal(proPaymentMethodWords('balance'), 'TipMe balance');
  assert.equal(proPaymentMethodWords(null), 'Not recorded');
});

test('a refund’s state reads as what is true now: asked is never refunded', () => {
  assert.equal(proRefundStateWords(null), 'None');
  assert.equal(
    proRefundStateWords({ status: 'REQUESTED' }),
    'Asked, not sent yet',
  );
  assert.equal(
    proRefundStateWords({ status: 'PROCESSING' }),
    'With our payment partner',
  );
  assert.equal(
    proRefundStateWords({ status: 'UNKNOWN' }),
    'Sent, waiting for an answer',
  );
  assert.equal(proRefundStateWords({ status: 'PAID' }), 'Refunded');
  assert.equal(proRefundStateWords({ status: 'FAILED' }), 'Failed');
  for (const status of ['REQUESTED', 'PROCESSING', 'UNKNOWN', 'PAID', 'FAILED'])
    assert.doesNotMatch(proRefundStateWords({ status }), /bachs/i);
});

test('the refund is offered only while the switch is on and the server says it can be refunded', () => {
  assert.deepEqual(proRefundOffer(payment(), { refundsOn: true }), {
    kind: 'ask',
  });
  // Switched off: the history shows, and no button that would only be refused.
  assert.deepEqual(proRefundOffer(payment(), { refundsOn: false }), {
    kind: 'switched_off',
  });
  // The server's own reason, as it wrote it.
  const late = payment({
    refundable: false,
    words: 'Pro payments can be refunded within 14 days of payment only.',
  });
  assert.deepEqual(proRefundOffer(late, { refundsOn: true }), {
    kind: 'not_refundable',
    words: 'Pro payments can be refunded within 14 days of payment only.',
  });
  // Off and not refundable anyway: the reason still matters more than the switch.
  assert.equal(
    proRefundOffer(late, { refundsOn: false }).kind,
    'not_refundable',
  );
});

const issue = (subject, over = {}) => ({
  kind: 'payment_reversed',
  status: 'open',
  subject: { tipId: '00000000-0000-4000-8000-0000000000aa', ...subject },
  ...over,
});

test('a paid refund can be taken back for exactly what the partner says it gave back', () => {
  assert.deepEqual(
    tipReverseView(
      issue({
        partnerReversalId: 'refund.re_1',
        refundState: 'paid',
        refundedMinor: '400000',
        refundFeeMinor: '0',
      }),
    ),
    { kind: 'refund', refundedMinor: '400000' },
  );
});

test('a chargeback can be taken back for the amount staff read on the partner’s dashboard', () => {
  assert.deepEqual(
    tipReverseView(issue({ partnerReversalId: 'dispute.dp_1' })),
    { kind: 'dispute' },
  );
});

test('a refund not paid yet, or failed, says why it can’t be taken back yet', () => {
  const pending = tipReverseView(
    issue({ partnerReversalId: 'refund.re_2', refundState: 'pending' }),
  );
  assert.equal(pending.kind, 'wait');
  assert.match(pending.words, /hasn’t said this refund is paid/);
  const failed = tipReverseView(
    issue({ partnerReversalId: 'refund.re_3', refundState: 'failed' }),
  );
  assert.equal(failed.kind, 'wait');
  assert.match(failed.words, /failed: nothing moved/);
  // Paid but with no amount read: the partner's dashboard decides, and the issue is closed by hand.
  assert.equal(
    tipReverseView(
      issue({ partnerReversalId: 'refund.re_4', refundState: 'paid' }),
    ).kind,
    'wait',
  );
});

test('a report naming no refund or dispute can’t be taken back from TipMe', () => {
  const view = tipReverseView(issue({}));
  assert.equal(view.kind, 'cannot');
  assert.match(view.words, /names no refund or dispute/);
  assert.doesNotMatch(view.words, /bachs/i);
});

test('nothing is offered on other issues, or once the issue is resolved', () => {
  assert.equal(
    tipReverseView(
      issue({ partnerReversalId: 'dispute.dp_1' }, { status: 'resolved' }),
    ).kind,
    'none',
  );
  assert.equal(
    tipReverseView(
      issue({ partnerReversalId: 'dispute.dp_1' }, { kind: 'stuck_tip' }),
    ).kind,
    'none',
  );
});
