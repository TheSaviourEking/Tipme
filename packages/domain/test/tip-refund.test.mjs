import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TIP_REFUND_TRANSITIONS,
  canTransition,
  priceTip,
  FEE_POLICY_V2_FREE,
  FEE_POLICY_V2_PRO,
  splitShare,
  tipRefundParts,
} from '../dist/index.js';

// Owner, 14 Nov 2026: a staff "Refund tip" asks our payment partner for the tip minus TipMe's fee on
// that tip's quote; TipMe keeps its fee. At a business, the person and the business each give back
// exactly what they received, and together that is the refund.

test('a Free ₦10,000 tip refunds ₦9,300; a Pro one ₦9,500', () => {
  const free = priceTip(1_000_000n, FEE_POLICY_V2_FREE);
  assert.deepEqual(
    tipRefundParts({ recipientNetMinor: free.recipientNetMinor }),
    { refundMinor: 930000n, personMinor: 930000n, businessMinor: 0n },
  );
  const pro = priceTip(1_000_000n, FEE_POLICY_V2_PRO);
  assert.equal(
    tipRefundParts({ recipientNetMinor: pro.recipientNetMinor }).refundMinor,
    950000n,
  );
});

test('at a business each side gives back exactly what it received, together the refund', () => {
  const net = 930000n;
  const { businessMinor: share } = splitShare(net, 2000);
  const parts = tipRefundParts({
    recipientNetMinor: net,
    businessShareMinor: share,
  });
  assert.deepEqual(parts, {
    refundMinor: 930000n,
    personMinor: 744000n,
    businessMinor: 186000n,
  });
  assert.equal(parts.personMinor + parts.businessMinor, parts.refundMinor);
});

test('a share larger than the net, or nothing to refund, is refused', () => {
  assert.throws(
    () => tipRefundParts({ recipientNetMinor: 100n, businessShareMinor: 101n }),
    RangeError,
  );
  assert.throws(() => tipRefundParts({ recipientNetMinor: 0n }), RangeError);
});

test('a tip refund moves like a Pro refund: only refund.paid makes it PAID, and FAILED is final', () => {
  assert.equal(
    canTransition(TIP_REFUND_TRANSITIONS, 'REQUESTED', 'PROCESSING'),
    true,
  );
  assert.equal(
    canTransition(TIP_REFUND_TRANSITIONS, 'PROCESSING', 'PAID'),
    true,
  );
  assert.equal(canTransition(TIP_REFUND_TRANSITIONS, 'FAILED', 'PAID'), false);
  assert.equal(canTransition(TIP_REFUND_TRANSITIONS, 'PAID', 'FAILED'), false);
});
