// Status names follow the PRD (section 6.3). History is never rewritten: terminal states have no exits.
export const TIP_STATUSES = [
  'DRAFT',
  'AWAITING_PAYMENT',
  'PENDING_VERIFICATION',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export const ATTEMPT_STATUSES = [
  'CREATED',
  'STARTING',
  'INITIATED',
  'PENDING',
  'VERIFIED_SUCCEEDED',
  'VERIFIED_FAILED',
  'EXPIRED',
  'UNKNOWN',
] as const;
export const PAYOUT_STATUSES = [
  'REQUESTED',
  'PROCESSING',
  'PAID',
  'FAILED',
  'REVERSED',
] as const;

export type TipStatus = (typeof TIP_STATUSES)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export type TransitionTable<S extends string> = Readonly<
  Record<S, readonly S[]>
>;

export const TIP_TRANSITIONS: TransitionTable<TipStatus> = {
  DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: [
    'PENDING_VERIFICATION',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
  ],
  PENDING_VERIFICATION: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

// STARTING claims the one allowed provider create call before it leaves TipMe. A signed event can
// establish that an ambiguous create produced a pending checkout; UNKNOWN can then resolve to a
// known provider reference/status, but never back to CREATED (which would permit a duplicate write).
export const ATTEMPT_TRANSITIONS: TransitionTable<AttemptStatus> = {
  CREATED: [
    'STARTING',
    'INITIATED',
    'PENDING',
    'VERIFIED_SUCCEEDED',
    'VERIFIED_FAILED',
    'EXPIRED',
    'UNKNOWN',
  ],
  STARTING: [
    'INITIATED',
    'PENDING',
    'VERIFIED_SUCCEEDED',
    'VERIFIED_FAILED',
    'UNKNOWN',
  ],
  INITIATED: [
    'PENDING',
    'VERIFIED_SUCCEEDED',
    'VERIFIED_FAILED',
    'EXPIRED',
    'UNKNOWN',
  ],
  PENDING: ['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'EXPIRED', 'UNKNOWN'],
  UNKNOWN: ['PENDING', 'VERIFIED_SUCCEEDED', 'VERIFIED_FAILED'],
  VERIFIED_SUCCEEDED: [],
  VERIFIED_FAILED: [],
  EXPIRED: [],
};

export const PAYOUT_TRANSITIONS: TransitionTable<PayoutStatus> = {
  REQUESTED: ['PROCESSING', 'PAID', 'FAILED'],
  PROCESSING: ['PAID', 'FAILED'],
  PAID: ['REVERSED'],
  FAILED: [],
  REVERSED: [],
};

/**
 * Paid Pro purchases (ADR-0015). PENDING: a checkout is open. UNKNOWN: its creation's answer was
 * lost. REVIEW: money arrived that doesn't match (staff decide). A confirmed payment is PAID even
 * after the purchase expired or failed (a late bank transfer is credited); PAID and REVIEW are final.
 * COLLECTING is the balance payment's (not built yet).
 */
export const PRO_PURCHASE_STATUSES = [
  'PENDING',
  'COLLECTING',
  'UNKNOWN',
  'PAID',
  'FAILED',
  'EXPIRED',
  'REVIEW',
] as const;
export type ProPurchaseStatus = (typeof PRO_PURCHASE_STATUSES)[number];

export const PRO_PURCHASE_TRANSITIONS: TransitionTable<ProPurchaseStatus> = {
  PENDING: ['UNKNOWN', 'PAID', 'FAILED', 'EXPIRED', 'REVIEW'],
  // A balance transfer or a saved-card charge in flight. A charge the partner is still processing
  // waits as PENDING; a read-back that disagrees goes to REVIEW.
  COLLECTING: ['PAID', 'FAILED', 'UNKNOWN', 'PENDING', 'REVIEW'],
  UNKNOWN: ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REVIEW'],
  PAID: [],
  FAILED: ['PAID', 'REVIEW'],
  EXPIRED: ['PAID', 'REVIEW'],
  REVIEW: [],
};

/** A staff refund of a card-paid Pro month (plan Task 9). Only refund.paid makes it PAID. */
export const PRO_REFUND_STATUSES = [
  'REQUESTED',
  'PROCESSING',
  'UNKNOWN',
  'PAID',
  'FAILED',
] as const;
export type ProRefundStatus = (typeof PRO_REFUND_STATUSES)[number];

export const PRO_REFUND_TRANSITIONS: TransitionTable<ProRefundStatus> = {
  REQUESTED: ['PROCESSING', 'UNKNOWN', 'FAILED', 'PAID'],
  PROCESSING: ['PAID', 'FAILED'],
  UNKNOWN: ['PROCESSING', 'PAID', 'FAILED'],
  PAID: [],
  FAILED: [],
};

// "You collect" transfer of a held share (Ruling R10). A refusal is not stored: it returns the row
// to `ready` (insufficient) or `waiting` (capability), or sends it to `review`. `review` is generic
// on purpose: the reason (dispute, shared bank account, provider problem) is separate data, so a
// later reason-aware rule can narrow exits without changing this table. `sent` and `unknown` can
// never be cancelled: money may already be on its way.
export const COLLECT_TRANSFER_STATUSES = [
  'waiting',
  'ready',
  'sent',
  'unknown',
  'paid',
  'cancelled',
  'review',
] as const;
export type CollectTransferStatus = (typeof COLLECT_TRANSFER_STATUSES)[number];
export const COLLECT_TRANSFER_TRANSITIONS: TransitionTable<CollectTransferStatus> =
  {
    waiting: ['ready', 'cancelled', 'review'],
    ready: ['sent', 'waiting', 'cancelled', 'review'],
    sent: ['paid', 'unknown', 'ready', 'waiting', 'review'],
    unknown: ['paid', 'ready', 'review'],
    // Back to `waiting` when the row has no account yet (held for review before the recipient added
    // bank details): `ready` needs one (collect_transfers_account).
    review: ['ready', 'waiting', 'cancelled', 'paid'],
    paid: [],
    cancelled: [],
  };

// Partner dispute states. "closed" = withdrawn by the supporter, treated as won.
export const DISPUTE_STATUSES = [
  'open',
  'responded',
  'won',
  'lost',
  'closed',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

const DISPUTE_RANK: Record<DisputeStatus, number> = {
  open: 0,
  responded: 1,
  won: 2,
  lost: 2,
  closed: 2,
};

/** Out-of-order safe: final states never move, and a report never moves the status backwards. */
export function disputeStatusAfter(
  current: DisputeStatus,
  reported: DisputeStatus,
): DisputeStatus {
  if (DISPUTE_RANK[current] === 2) return current;
  return DISPUTE_RANK[reported] >= DISPUTE_RANK[current] ? reported : current;
}

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from]?.includes(to) ?? false;
}
