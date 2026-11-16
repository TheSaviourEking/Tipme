import type { OpsProPayment } from '@tipme/contracts';

/*
 * A page's Pro payments in admin (16 Nov 2026): plain words for each column, and whether the
 * reasoned "Refund…" is offered. The API decides again (`pro_refunds` switch, `pro.refund`). No
 * imports beyond types, so the rules can be tested alone; never the partner's name.
 */

const METHOD_WORDS: Record<NonNullable<OpsProPayment['paidBy']>, string> = {
  card: 'Card',
  saved_card: 'Saved card (auto-renew)',
  bank_transfer: 'Bank transfer',
  balance: 'TipMe balance',
};

export const proPaymentMethodWords = (paidBy: OpsProPayment['paidBy']) =>
  paidBy ? METHOD_WORDS[paidBy] : 'Not recorded';

const REFUND_WORDS: Record<
  NonNullable<OpsProPayment['refund']>['status'],
  string
> = {
  REQUESTED: 'Asked, not sent yet',
  PROCESSING: 'With our payment partner',
  UNKNOWN: 'Sent, waiting for an answer',
  PAID: 'Refunded',
  FAILED: 'Failed',
};

/** Asked is never refunded: only our payment partner's confirmation makes it so. */
export const proRefundStateWords = (refund: OpsProPayment['refund']) =>
  refund ? REFUND_WORDS[refund.status] : 'None';

export type ProRefundOffer =
  | { kind: 'ask' }
  | { kind: 'switched_off' }
  | { kind: 'not_refundable'; words: string };

/**
 * What the row's "…" offers. The server's own reason wins over the switch (a bank transfer can't be
 * refunded either way); with the switch off there is no button that would only be refused.
 */
export function proRefundOffer(
  payment: Pick<OpsProPayment, 'refundable' | 'words'>,
  { refundsOn }: { refundsOn: boolean },
): ProRefundOffer {
  if (!payment.refundable)
    return { kind: 'not_refundable', words: payment.words };
  return refundsOn ? { kind: 'ask' } : { kind: 'switched_off' };
}
