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

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from]?.includes(to) ?? false;
}
