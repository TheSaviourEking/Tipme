import {
  PRO_REFUND_STATUSES,
  PRO_REFUND_TRANSITIONS,
} from './state-machines.js';

/**
 * A staff "Refund tip" (owner, 14 Nov 2026), behind TIP_REFUNDS. TipMe keeps its fee: the supporter
 * gets back the tip minus TipMe's fee on that tip's quote, which is exactly what its recipients
 * received (`recipientNetMinor`). At a business, the person gives back their part and the business
 * its share (`businessShareMinor`), each exactly what it received, together the refund.
 */
export function tipRefundParts(input: {
  recipientNetMinor: bigint;
  businessShareMinor?: bigint;
}): { refundMinor: bigint; personMinor: bigint; businessMinor: bigint } {
  const refundMinor = input.recipientNetMinor;
  const businessMinor = input.businessShareMinor ?? 0n;
  if (refundMinor <= 0n) throw new RangeError('nothing to refund');
  if (businessMinor < 0n || businessMinor > refundMinor)
    throw new RangeError('a share is part of what the recipients received');
  return {
    refundMinor,
    personMinor: refundMinor - businessMinor,
    businessMinor,
  };
}

/** A tip refund moves like a Pro refund: only the partner's refund.paid makes it PAID. */
export const TIP_REFUND_STATUSES = PRO_REFUND_STATUSES;
export type TipRefundStatus = (typeof TIP_REFUND_STATUSES)[number];
export const TIP_REFUND_TRANSITIONS = PRO_REFUND_TRANSITIONS;
