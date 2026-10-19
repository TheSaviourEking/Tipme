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

// Provider events can arrive before TipMe records INITIATED, so CREATED may jump straight to a verdict.
// UNKNOWN resolves only to a verified outcome, never back to pending.
export const ATTEMPT_TRANSITIONS: TransitionTable<AttemptStatus> = {
  CREATED: [
    'INITIATED',
    'PENDING',
    'VERIFIED_SUCCEEDED',
    'VERIFIED_FAILED',
    'EXPIRED',
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
  UNKNOWN: ['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED'],
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

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from]?.includes(to) ?? false;
}
