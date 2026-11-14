import { z } from 'zod';
import type { WebVitalSummary } from './analytics.js';
import { OPS_PERMISSIONS } from './ops-catalogue.js';
import type { ProfileReportReason } from './profiles.js';

// Staff admin area (PR-009, ADR-0010).

export const opsEnrolSchema = z
  .object({ enrolmentCode: z.string().regex(/^[A-Za-z2-7]{10}$/) })
  .strict();
export type OpsEnrolRequest = z.infer<typeof opsEnrolSchema>;

export const opsCodeSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict();
export type OpsCodeRequest = z.infer<typeof opsCodeSchema>;

export interface OpsEnrolment {
  secret: string;
  otpauthUrl: string;
}

/** What `/v1/ops/me` tells a staff member; everyone else gets 404. */
export type OpsMe =
  | { state: 'needs_enrolment'; canDecline: boolean }
  | { state: 'needs_code' }
  | { state: 'granted'; role: string; permissions: string[] };

/** One line of who changed what among staff (spec 6.4): fixed names, never the written reason. */
export interface OpsStaffActivity {
  seq: number;
  action: string;
  staffUserId: string | null;
  staffHint: string | null;
  /** For an action taken alone: which one. */
  seriousAction: string | null;
  at: string;
}

export interface OpsAuditEntry {
  seq: number;
  staffUserId: string | null;
  action: string;
  permission: string | null;
  subjectType: string | null;
  subjectId: string | null;
  reason: string | null;
  traceId: string | null;
  createdAt: string;
}

/** A written reason for any change or private-data reveal. */
export const opsReasonSchema = z
  .object({ reason: z.string().trim().min(10).max(500) })
  .strict();
export type OpsReasonRequest = z.infer<typeof opsReasonSchema>;

export const OPS_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'stale',
] as const;
export type OpsApprovalStatus = (typeof OPS_APPROVAL_STATUSES)[number];

/** Why a request closed without running: fixed codes, for a screen to put into words. */
export const OPS_APPROVAL_STALE_REASONS = [
  'requester_lost_access',
  'requester_removed',
  'requester_reset',
  'facts_changed',
  'description_changed',
  'permission_changed',
  'action_unknown',
  'superseded',
] as const;
export type OpsApprovalStaleReason =
  (typeof OPS_APPROVAL_STALE_REASONS)[number];

/** A code entered for this approval: a recent one in the session doesn't count (spec 6.9). */
export const opsApproveSchema = opsCodeSchema
  .extend({ reason: z.string().trim().min(10).max(500).optional() })
  .strict();
export type OpsApproveRequest = z.infer<typeof opsApproveSchema>;

export const opsApprovalListSchema = z
  .object({ status: z.enum(OPS_APPROVAL_STATUSES).optional() })
  .strict();
export type OpsApprovalListQuery = z.infer<typeof opsApprovalListSchema>;

/** A request as a screen shows it: the words fixed when asked for, and never the payload. */
export interface OpsApproval {
  id: string;
  action: string;
  summary: string;
  permission: string;
  requestedBy: string;
  requestedByHint: string | null;
  reason: string;
  status: OpsApprovalStatus;
  decidedBy: string | null;
  decidedByHint: string | null;
  decidedReason: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  mine: boolean;
  /** Whether this viewer could approve or reject it now. */
  canDecide: boolean;
  /** Waiting, with nobody left who could decide: the requester can cancel and act alone. */
  nobodyElseQualified: boolean;
}

/** A serious action waiting for a second person: its route answers 202 with this. */
export interface OpsSeriousPending {
  requestId: string;
  /** The same thing was already waiting, and this is that request. */
  repeat?: true;
}

/** On a serious action's normal answer, when it ran because nobody else could approve it. */
export interface OpsActedAlone {
  actedAlone?: true;
}

/** Closing a takeover: its freeze lifted, or another open issue still holds withdrawals. */
export interface OpsFreezeReleased {
  withdrawals: 'released' | 'still_held';
  stillOpen: { id: string; kind: string }[];
}

export interface OpsApprovalApproved {
  status: 'approved';
}

/** Resolving an issue: a money issue must also say how it was settled (the operation checks). */
export const opsResolveIssueSchema = opsReasonSchema
  .extend({
    outcome: z
      .enum([
        'resolved_by_provider',
        'recipient_owes',
        'written_off',
        'account_secured',
      ])
      .optional(),
    // Closing a reported takeover: staff confirm they checked the current bank and the sign-in.
    bankAndSignInChecked: z.boolean().optional(),
  })
  .strict();
export type OpsResolveIssueRequest = z.infer<typeof opsResolveIssueSchema>;

/** Apply what the provider reports: names what staff saw, so a changed answer is not applied. */
export const opsPayoutApplySchema = opsReasonSchema
  .extend({ reported: z.enum(['paid', 'failed']) })
  .strict();
export type OpsPayoutApplyRequest = z.infer<typeof opsPayoutApplySchema>;

export const opsPayoutMarkFailedSchema = opsReasonSchema
  .extend({ dashboardVerified: z.literal(true) })
  .strict();
export type OpsPayoutMarkFailedRequest = z.infer<
  typeof opsPayoutMarkFailedSchema
>;

/** What the provider said just now about a withdrawal issue, and what staff may do about it. */
export interface OpsPayoutIssueView {
  issueId: string;
  issueStatus: 'open' | 'resolved';
  payoutStatus: string;
  startStep: 'fee' | 'payout' | null;
  startAttemptedAt: string | null;
  holdActive: boolean;
  /** This recipient has had a reported takeover: the bank on this withdrawal may be the thief's. */
  takeoverReported: boolean;
  /** A signed event names this payout, so "the provider has none" isn't believed. */
  parkedEvent: boolean;
  /** Another open conflict is about this payout. */
  openConflict: boolean;
  /** The recipient has changed bank since; a resumed payout still goes to the recorded one. */
  destinationReplaced: boolean;
  /** A hold was in force at some point since this withdrawal was requested. */
  holdTouched: boolean;
  read: {
    state:
      | 'paid'
      | 'failed'
      | 'pending'
      | 'review'
      | 'absent'
      | 'uncertain'
      | 'ambiguous'
      | 'conflicting';
    referenceTail: string | null;
    /** The fields, by name, where it differs from what TipMe asked for. */
    differing: string[];
    failureReason: string | null;
  };
  offers: {
    applyReported: 'paid' | 'failed' | null;
    resume: boolean;
    markFailed: boolean;
  };
}

export interface OpsPayoutActionResult {
  outcome:
    | 'applied'
    | 'resumed'
    | 'marked_failed'
    | 'mismatch'
    | 'not_offered'
    | 'not_open';
  view: OpsPayoutIssueView;
}

export const ISSUE_KINDS = [
  'payment_mismatch',
  'payment_conflict',
  'payment_unresolved',
  'payment_attempt_unresolved',
  'payment_account_unresolved',
  'payment_account_setup_failed',
  'payment_reversed',
  'payment_settlement_currency',
  'payout_failed',
  'payout_conflict',
  'payout_unexpected',
  'payout_unresolved',
  'payout_fee_short',
  'payout_fee_adjusted',
  'payout_held',
  'provider_in_debt',
  'provider_event_conflict',
  'stuck_tip',
  'unmatched_event',
  'pending_recovery',
  'message_reported',
  'profile_reported',
  'account_takeover_reported',
  'reserve_empty',
  'provider_key_refused',
  'staff_acted_alone',
  'staff_approval_pending',
  'staff_last_approver_removed',
  'username_take_back_unnoticed',
  'username_take_back_overdue',
  'business_waiting',
  'business_note_reported',
  // Business release 2 (R2-0): a staff member reported their business over a share (never shown
  // to the business), and a reversal left a person's or a business's balance below zero (Q8).
  'share_report',
  'balance_below_zero',
  // Paid Pro (ADR-0015): a Pro payment that doesn't match its purchase (nothing booked), one that
  // arrived after its checkout ended (credited), a contradiction after it was paid, and a refund
  // or dispute on one.
  'pro_amount_mismatch',
  'pro_late_payment',
  'pro_conflict',
  'pro_reversed',
  // Priority support: a person's support request (its words are kept apart, read by reveal).
  'support_request',
  // Paid Pro: a balance payment the partner never answered, and a refund the partner refused.
  'pro_collect_unknown',
  'pro_refund_failed',
  // Business release 2, option B: a share movement between partner accounts that needs a person
  // (TipMe holds a business's share it could not send on, or a transfer's answer didn't match).
  'share_transfer_stuck',
] as const;
export type OpsIssueKind = (typeof ISSUE_KINDS)[number];
/**
 * How staff settled a money issue. Stored with their reason; TipMe changes no balance by it
 * (the provider, or the recipient, settles the money).
 */
export const ISSUE_OUTCOMES = [
  'resolved_by_provider',
  'recipient_owes',
  'written_off',
  // Only the mark-failed tool states this: staff looked, and the provider has no such payout.
  'staff_confirmed_absent',
  // Staff froze withdrawals after a reported takeover, and the owner has the account back.
  'account_secured',
] as const;
export type OpsIssueOutcome = (typeof ISSUE_OUTCOMES)[number];

/** Outcomes in plain words: for the screens, and fixed into a request's summary when asked. */
export const OPS_ISSUE_OUTCOME_WORDS: Record<OpsIssueOutcome, string> = {
  resolved_by_provider: 'Settled by the provider',
  recipient_owes: 'The recipient owes the money',
  written_off: 'Written off by TipMe',
  account_secured: 'The real owner has the account back',
  staff_confirmed_absent: 'Staff confirmed the provider has no such payout',
};
export type OpsIssueSeverity = 'money' | 'account' | 'info';

/** What an issue is about: ids only (no names, messages or numbers). */
export interface OpsIssueSubject {
  tipId?: string;
  attemptId?: string;
  payoutId?: string;
  profileId?: string;
  userId?: string;
  unmatchedId?: string;
  recoveryId?: string;
  requestId?: string;
  providerEventRowId?: string;
  /** TipMe for businesses: the business (business_waiting) or the noted tip's business. */
  businessId?: string;
  /**
   * Business release 2 (R2-A): the partner's refund or dispute a `payment_reversed` issue is about
   * (`refund.<id>` / `dispute.<id>`). Only an issue with one can be reversed from TipMe.
   */
  partnerReversalId?: string;
  /**
   * A refund's state from the partner (its refund guide): `pending` once accepted, then `paid` or
   * `failed`, both final. Only a paid refund can be reversed, for exactly `refundedMinor`.
   */
  refundState?: 'pending' | 'paid' | 'failed';
  /** What a paid refund gave back, in minor units (decimal string). */
  refundedMinor?: string;
  /** A fee the paid refund itself carried, in minor units (decimal string): TipMe's expense. */
  refundFeeMinor?: string;
}

export interface OpsIssue {
  id: string;
  kind: OpsIssueKind;
  severity: OpsIssueSeverity;
  status: 'open' | 'resolved';
  subject: OpsIssueSubject;
  summary: string;
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionOutcome: OpsIssueOutcome | null;
  /** A Pro member's support request: answered first, sorted first among open issues. */
  priority: boolean;
}

export const opsIssueListQuerySchema = z
  .object({
    status: z.enum(['open', 'resolved']).optional(),
    severity: z.enum(['money', 'account', 'info']).optional(),
    kind: z.enum(ISSUE_KINDS).optional(),
    cursor: z.uuid().optional(),
    // Release-check issues are hidden unless asked for (PR-010).
    includeRehearsal: z.literal('1').optional(),
  })
  .strict();
export type OpsIssueListQuery = z.infer<typeof opsIssueListQuerySchema>;

/** Both proofs for one tip (PR-005): the verified payment and, once paid out, the payout. */
export interface TipProofView {
  tip: {
    id: string;
    status: string;
    currency: string;
    grossMinor: string;
    completedAt: string | null;
  };
  payment: {
    attemptId: string;
    providerReference: string | null;
    providerEventId: string;
    verifiedAt: string;
  } | null;
  breakdown: {
    grossMinor: string;
    platformFeeMinor: string;
    quotedProviderFeeMinor: string;
    actualProviderFeeMinor: string | null;
    recipientNetMinor: string;
  };
  paymentLedgerTransactionId: string | null;
  payout: {
    payoutId: string;
    status: string;
    providerReference: string | null;
    paidAt: string | null;
    ledgerTransactionId: string | null;
  } | null;
  history: {
    entityType: string;
    fromStatus: string | null;
    toStatus: string;
    cause: string;
    providerEventId: string | null;
    traceId: string | null;
    at: string;
  }[];
}

/**
 * Everything staff need to resolve an issue or decide, assembled on request. Private details
 * (supporter message and name, full phone and email) are absent: `private` only says whether
 * they exist, and the reveal route returns them (with a reason, audited by the caller).
 */
export interface OpsIssueEvidence {
  issue: OpsIssue;
  notes: {
    id: string;
    staffUserId: string | null;
    text: string;
    createdAt: string;
  }[];
  tipProof: TipProofView | null;
  attempts: {
    id: string;
    status: string;
    provider: string | null;
    referenceTail: string | null;
    createdAt: string;
    lastReconciledAt: string | null;
  }[];
  providerEvents: {
    id: string;
    provider: string;
    eventIdTail: string;
    eventType: string;
    processingOutcome: string | null;
    receivedAt: string;
    processedAt: string | null;
  }[];
  payout: {
    id: string;
    status: string;
    amountMinor: string;
    currency: string;
    referenceTail: string | null;
    createdAt: string;
    paidAt: string | null;
    /** The last provider call a start noted before making it. */
    startStep: 'fee' | 'payout' | null;
    startAttemptedAt: string | null;
    inProviderReview: boolean;
    history: {
      fromStatus: string | null;
      toStatus: string;
      cause: string;
      at: string;
    }[];
  } | null;
  page: {
    profileId: string;
    handle: string;
    pageState: string;
    status: string;
    suspendedReason: string | null;
  } | null;
  /** Visitors' reports of this page since the issue opened (PR-013), counts by reason only. */
  pageReports?: { reason: ProfileReportReason; count: number }[];
  person: {
    userId: string;
    phoneHint: string | null;
    emailMasked: string | null;
    emailVerified: boolean;
    deleted: boolean;
  } | null;
  unmatched: {
    id: string;
    provider: string;
    eventType: string;
    reason: string;
    receivedAt: string;
  } | null;
  recovery: {
    id: string;
    newPhoneHint: string;
    effectiveAt: string;
    cancelledAt: string | null;
    completedAt: string | null;
  } | null;
  traceId: string | null;
  related: OpsIssue[];
  /**
   * The recipient's withdrawals are on hold: these open issues keep them there. Empty otherwise.
   * Optional for the copy of the web that deploys before the API.
   */
  holdPins?: OpsIssue[];
  private: {
    message: boolean;
    supporterLabel: boolean;
    phone: boolean;
    email: boolean;
  };
}

/** Revealed with `private.view` and a written reason (audited). */
export interface OpsPrivateDetails {
  message?: string;
  supporterLabel?: string;
  phone?: string;
  email?: string;
}

export const opsNoteSchema = z
  .object({ text: z.string().trim().min(1).max(2000) })
  .strict();
export type OpsNoteRequest = z.infer<typeof opsNoteSchema>;

/** Re-check exactly one attempt or one payout with the provider. */
export const opsRecheckSchema = z
  .object({
    attemptId: z.uuid().optional(),
    payoutId: z.uuid().optional(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict()
  .refine((value) => Boolean(value.attemptId) !== Boolean(value.payoutId), {
    message: 'exactly one of attemptId or payoutId',
    path: ['attemptId'],
  });
export type OpsRecheckRequest = z.infer<typeof opsRecheckSchema>;

export type OpsRecheckOutcome =
  'applied' | 'unchanged' | 'unresolved' | 'error' | 'not_pending';

/**
 * A Bachs ID as staff copy it from the dashboard. Bachs documents IDs as opaque, so no prefix is
 * required; whitespace, `/` and `:` are refused (TipMe scopes checkouts as `<account>:<checkout>`).
 */
const providerIdSchema = z
  .string()
  .regex(/^[^\s:/\u0000-\u001f\u007f]{1,200}$/);

/** Attach a dashboard-found checkout ID only after the server verifies its scoped status. */
/**
 * Business release 2 (Q7): staff confirm a refund or chargeback the payment partner reported, from
 * its `payment_reversed` issue, after checking the partner's dashboard. `refundedMinor` is what the
 * partner took back of the supporter's payment; less than the tip is a partial refund, taken back
 * from every line in proportion. `dashboardVerified` is the staff member's word that they checked.
 */
export const opsTipReverseSchema = opsReasonSchema
  .extend({
    refundedMinor: z.string().regex(/^[1-9]\d{0,11}$/),
    dashboardVerified: z.literal(true),
  })
  .strict();
export type OpsTipReverseRequest = z.infer<typeof opsTipReverseSchema>;

/** A reversal that ran: whether it posted now, and whether it left a balance below zero (Q8). */
export interface OpsTipReversed {
  reversed: true;
  /** False when this refund event was already reversed: nothing new was posted. */
  posted: boolean;
  belowZero: boolean;
}

export const opsBachsCheckoutRecoverySchema = opsReasonSchema
  .extend({
    issueId: z.uuid(),
    attemptId: z.uuid(),
    checkoutId: providerIdSchema,
    dashboardVerified: z.literal(true),
  })
  .strict();
export type OpsBachsCheckoutRecoveryRequest = z.infer<
  typeof opsBachsCheckoutRecoverySchema
>;

/**
 * Bachs took a tip's money but never reported who paid its processing fee. Staff who see in the
 * Bachs dashboard that the platform paid it confirm that one fact; everything else is read back.
 */
export const opsBachsFeeBearerSchema = opsReasonSchema
  .extend({
    issueId: z.uuid(),
    feePaidBy: z.literal('platform'),
    dashboardVerified: z.literal(true),
  })
  .strict();
export type OpsBachsFeeBearerRequest = z.infer<typeof opsBachsFeeBearerSchema>;

/** Recover an ambiguous sandbox account after staff match it in the provider dashboard. */
export const opsBachsAccountRecoverySchema = opsReasonSchema
  .extend({
    issueId: z.uuid(),
    accountReference: providerIdSchema,
    dashboardVerified: z.literal(true),
  })
  .strict();
export type OpsBachsAccountRecoveryRequest = z.infer<
  typeof opsBachsAccountRecoverySchema
>;

/** A count this week (Monday 00:00 Lagos to now) and the whole of last week. */
export interface OpsWeekCount {
  thisWeek: number;
  lastWeek: number;
}
/** Money in minor units (NGN while D-01 is open), as decimal strings. */
export interface OpsWeekMoney {
  thisWeek: string;
  lastWeek: string;
}

/**
 * The latest read of the platform's payment reserve, for staff only (the public health route says
 * only low or not). `availableMinor` and `low` are null when the balance could not be read.
 */
export interface OpsPaymentReserve {
  /** The adapter name, e.g. bachs-live. Staff screens may name providers. */
  provider: string;
  currency: string;
  availableMinor: string | null;
  /** The alert level: below this the reserve is low. */
  thresholdMinor: string;
  low: boolean | null;
  readAt: string;
  /** Older than the worker's checks should allow: they may have stopped. */
  stale: boolean;
}

/** Overall health. Money and reliability come from the money tables; the funnel from events. */
export interface OpsHealth {
  weekStarts: { thisWeek: string; lastWeek: string };
  money: {
    currency: 'NGN';
    tipCount: OpsWeekCount;
    grossMinor: OpsWeekMoney;
    platformFeeMinor: OpsWeekMoney;
    /** Waived TipMe fees plus cash bonuses (pretend money). */
    rewardCostMinor: OpsWeekMoney;
  };
  reliability: {
    /** Declined ÷ (paid + declined) among tips started in the week; null with none. */
    declinedRate: { thisWeek: number | null; lastWeek: number | null };
    medianConfirmSeconds: { thisWeek: number | null; lastWeek: number | null };
    stuckNow: number;
    openIssues: { money: number; account: number; info: number };
  };
  recipients: {
    newSignups: OpsWeekCount;
    newPages: OpsWeekCount;
    livePages: number;
    recipientsTipped: OpsWeekCount;
    /** Tipped last week and again this week. */
    recipientsReturning: number;
  };
  /** This week: visits → amount chosen → payment started → paid. */
  funnel: {
    visits: number;
    amountSelected: number;
    paymentStarted: number;
    tipsCompleted: number;
  };
  /** Real-user web vitals, mobile, last 28 days (PR-011). Optional for the same reason as
   *  `MyProfile.previousHandles`: an older API does not send it. */
  webVitals?: WebVitalSummary[];
  /** Null before the first read (a copy without a payment provider reserve). Optional for the
   *  same reason as `webVitals`. */
  reserve?: OpsPaymentReserve | null;
  /** Null until live payments have ever been switched on. Optional as above. */
  liveSwitch?: OpsLiveSwitch | null;
  /** Optional as above. */
  liveNow?: OpsLiveNow;
  /** Optional as above. */
  withdrawalsSwitch?: OpsWithdrawalsSwitch;
}

/** All withdrawals stopped or restarted by staff: always with a written reason (audited). */
export const opsWithdrawalsSwitchSchema = opsReasonSchema
  .extend({ paused: z.boolean() })
  .strict();
export type OpsWithdrawalsSwitchRequest = z.infer<
  typeof opsWithdrawalsSwitchSchema
>;
export interface OpsWithdrawalsSwitch {
  paused: boolean;
  changedAt: string | null;
}

/** What the API answering now was started with, from its own config: the truth for this moment. */
export interface OpsLiveNow {
  live: boolean;
  provider: string;
  /** test: a test provider. closed: live provider, switched off. Else who may take real tips. */
  checkout: 'test' | 'closed' | 'nobody' | 'named' | 'everyone';
  handles: string[];
}

/** Latest change of live payments on this copy; the API records one at boot when it differs. */
export interface OpsLiveSwitch {
  live: boolean;
  provider: string;
  /** The deployed commit, or `unknown`. */
  version: string;
  switchedAt: string;
}

/** How people find recipients' pages, over the last `days` days (Lagos). */
export interface OpsVisibility {
  days: number;
  from: string;
  to: string;
  visits: number;
  returningVisits: number;
  visitsPerDay: { date: string; visits: number; returning: number }[];
  byChannel: { channel: string; visits: number }[];
  /** Sharing and QR events by name. */
  sharing: Record<string, number>;
  /** Paid tips added to a recipient's shared celebration. */
  celebrationTips: number;
  /** Admin only, never published. */
  topPages: { handle: string; visits: number }[];
}

/** Every metrics answer says whether anonymous collection is on (on unless ANALYTICS_ENABLED=false; D-07 open). */
export interface OpsMetricsEnvelope<T> {
  collecting: boolean;
  metrics: T;
}

// ---- Market notes: outside observations recorded by hand (PR-009) ----

export const MARKET_CATEGORIES = [
  'competitor',
  'social',
  'app_store',
  'press',
  'other',
] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // Observations are about the past (one day of leeway for time zones).
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      Date.parse(value) <= Date.now() + 86_400_000,
    { message: 'not a past date' },
  );
const httpsUrl = z.url({ protocol: /^https$/ }).max(500);

const marketFields = {
  observedOn: isoDate,
  category: z.enum(MARKET_CATEGORIES),
  name: z.string().trim().min(1).max(80),
  metric: z.string().trim().min(1).max(60),
  value: z.number().finite().nullable().optional(),
  text: z.string().trim().max(500).nullable().optional(),
  sourceUrl: httpsUrl,
  note: z.string().trim().max(500).nullable().optional(),
};
export const marketEntrySchema = z.object(marketFields).strict();
export type MarketEntryInput = z.infer<typeof marketEntrySchema>;
export const marketEntryPatchSchema = z
  .object(marketFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'nothing to change',
  });
export type MarketEntryPatch = z.infer<typeof marketEntryPatchSchema>;

export const marketListQuerySchema = z
  .object({
    category: z.enum(MARKET_CATEGORIES).optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export const marketSeriesQuerySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    metric: z.string().trim().min(1).max(60),
  })
  .strict();

export interface MarketEntry {
  id: string;
  observedOn: string;
  category: MarketCategory;
  name: string;
  metric: string;
  value: number | null;
  text: string | null;
  sourceUrl: string;
  note: string | null;
  createdAt: string;
}

/** A page as staff see it when changing its plan (PR-012). */
export interface OpsPage {
  profileId: string;
  /** The account behind the page; null once it has none. */
  userId: string | null;
  handle: string;
  displayName: string;
  plan: 'free' | 'pro';
  pageState: 'live' | 'not_live' | 'deleted';
  suspended: boolean;
  /** Optional until the release after the handle rule (the web deploys before the API). */
  handleChanges?: { used: number; allowed: number };
  /** Which images staff can review. Optional, as `handleChanges`. */
  images?: { hasCover: boolean; hasPhoto: boolean };
  /** Search only: the name searched for was taken back from this page, on this date. */
  takenBackOn?: string;
  /**
   * Paid Pro (ADR-0015): why the page is Pro — a staff grant, a paid month, or neither — and, while
   * a paid month runs, its end and its grace end (ISO). Optional: older APIs send nothing.
   */
  proSource?: 'staff' | 'paid' | null;
  paidUntil?: string | null;
  graceUntil?: string | null;
}

/** `GET /v1/ops/pages/:profileId/pro` (paid Pro, ADR-0015), for staff with `pages.plan`. */
export type OpsPageProStatus = Required<
  Pick<OpsPage, 'proSource' | 'paidUntil' | 'graceUntil'>
>;

/** A page's image, as staff review and remove it. */
export const OPS_PAGE_IMAGES = ['cover', 'photo'] as const;
export type OpsPageImage = (typeof OPS_PAGE_IMAGES)[number];

/** Making a page Pro or Free again: always with a written reason (audited). */
export const opsPagePlanSchema = opsReasonSchema
  .extend({ plan: z.enum(['free', 'pro']) })
  .strict();
export type OpsPagePlanRequest = z.infer<typeof opsPagePlanSchema>;

/** Staff allow a page more handle changes, on top of what it has: small, deliberate steps. */
export const MAX_HANDLE_CHANGE_GRANT = 10;
/** The most extra changes one page can hold in total; each leaves a name held for good. */
export const MAX_HANDLE_CHANGE_EXTRA = 20;
export const opsHandleChangesGrantSchema = opsReasonSchema
  .extend({ extra: z.number().int().min(1).max(MAX_HANDLE_CHANGE_GRANT) })
  .strict();
export type OpsHandleChangesGrantRequest = z.infer<
  typeof opsHandleChangesGrantSchema
>;
/** Staff froze a page's withdrawals after a reported takeover; `issueId` is the case that holds it. */
export interface OpsWithdrawalFreeze {
  state: 'frozen' | 'already_frozen';
  issueId: string;
}

/** Whether a page's withdrawals are frozen now, the issue that holds them, and if it's still open. */
export interface OpsWithdrawalFreezeState {
  issueId: string | null;
  issueOpen: boolean;
}

/**
 * One page's pricing for staff (ADR-0014): a staff-set share (null for none), the page's plan and
 * its rate (owner, 12 Nov 2026: Free 700, Pro 500 bps), and the rate new quotes use: the deal only
 * when it is below the plan's rate.
 */
export interface OpsPagePricing {
  customFeeBps: number | null;
  feeFreeRemaining: number;
  plan: 'free' | 'pro';
  planFeeBps: number;
  feeBps: number;
}

/** Staff set one page's TipMe fee in basis points (600 = 6%), or clear it with null (ADR-0014). Capped at the plan's rate when quoted. */
export const opsPageFeeSchema = opsReasonSchema
  .extend({ feeBps: z.number().int().min(0).max(10000).nullable() })
  .strict();
export type OpsPageFeeRequest = z.infer<typeof opsPageFeeSchema>;

/** Staff grant fee-free tips to one page (ADR-0014). */
export const opsFeeFreeGrantSchema = opsReasonSchema
  .extend({ count: z.number().int().min(1).max(100) })
  .strict();
export type OpsFeeFreeGrantRequest = z.infer<typeof opsFeeFreeGrantSchema>;

/**
 * Admin search results (PR-013): ids and short labels only. Never phone numbers, emails,
 * supporter names or messages.
 */
export interface OpsSearchResult {
  pages: OpsPage[];
  tips: {
    tipId: string;
    handle: string | null;
    status: string;
    grossMinor: string;
    currency: string;
    at: string;
  }[];
  payouts: {
    payoutId: string;
    handle: string | null;
    status: string;
    amountMinor: string;
    currency: string;
    at: string;
  }[];
  ledgerTransactions: {
    transactionId: string;
    operationType: string;
    tipId: string | null;
    payoutId: string | null;
    at: string;
  }[];
}

// ---- Mail providers (mail platform spec §5) ----

export const mailProviderNameSchema = z.enum(['mock', 'zeptomail', 'ses']);

export interface OpsMailProviderCard {
  name: z.infer<typeof mailProviderNameSchema>;
  label: string;
  active: boolean;
  /** True while it only delivers to verified recipients; null when the provider can't say. */
  sandbox: boolean | null;
  statusDetail: string | null;
  lastTest: {
    status: 'pending' | 'confirmed' | 'failed' | 'expired';
    startedAt: string;
    confirmedAt: string | null;
    targetHint: string | null;
    /** How the test email itself is doing: queued, sent, failed… */
    messageStatus: string | null;
    failureCode: string | null;
  } | null;
  /** A confirmed test is still valid, so this provider can be made active. */
  canActivate: boolean;
  last24h: {
    sent: number;
    failed: number;
    bounced: number;
    complained: number;
  };
}

export interface OpsMailProviderOverride {
  userId: string;
  handle: string | null;
  provider: string;
  reason: string;
  createdAt: string;
}

export interface OpsMailProviders {
  providers: OpsMailProviderCard[];
  overrides: OpsMailProviderOverride[];
  changedAt: string | null;
  reason: string | null;
}

export const opsMailTestSchema = opsReasonSchema
  .extend({ to: z.email().max(254).optional() })
  .strict();
export type OpsMailTestRequest = z.infer<typeof opsMailTestSchema>;

export const opsProviderTestConfirmSchema = z
  .object({ token: z.string().min(16).max(128) })
  .strict();
export type OpsProviderTestConfirmRequest = z.infer<
  typeof opsProviderTestConfirmSchema
>;

export const opsMailSwitchSchema = opsReasonSchema
  .extend({ provider: mailProviderNameSchema })
  .strict();
export type OpsMailSwitchRequest = z.infer<typeof opsMailSwitchSchema>;

/** `account` is a handle or a user id. */
export const opsMailOverrideSchema = opsReasonSchema
  .extend({
    account: z.string().trim().min(1).max(64),
    provider: mailProviderNameSchema,
  })
  .strict();
export type OpsMailOverrideRequest = z.infer<typeof opsMailOverrideSchema>;

export const opsMailOverrideRemoveSchema = opsReasonSchema
  .extend({ userId: z.uuid() })
  .strict();
export type OpsMailOverrideRemoveRequest = z.infer<
  typeof opsMailOverrideRemoveSchema
>;

// Addresses travel in the body, never the URL, so they stay out of access logs.
export const opsSuppressionLookupSchema = z
  .object({ address: z.email().max(254) })
  .strict();
export type OpsSuppressionLookupRequest = z.infer<
  typeof opsSuppressionLookupSchema
>;

export const opsSuppressionRemoveSchema = opsReasonSchema
  .extend({
    address: z.email().max(254),
    confirmComplaint: z.boolean().default(false),
  })
  .strict();
export type OpsSuppressionRemoveRequest = z.infer<
  typeof opsSuppressionRemoveSchema
>;

// ---- Email console (mail platform spec §5.1) ----

const mailPeriodFields = {
  period: z
    .enum([
      'today',
      'yesterday',
      'this_week',
      'last_week',
      'this_month',
      'last_month',
      'range',
    ])
    .default('this_month'),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};
const MAIL_RANGE_MAX_DAYS = 366;
/** A range needs both dates, in order, and at most a year. */
const validMailRange = (q: {
  period: string;
  from?: string | undefined;
  to?: string | undefined;
}) =>
  q.period !== 'range' ||
  Boolean(
    q.from &&
    q.to &&
    q.from <= q.to &&
    Date.parse(q.to) - Date.parse(q.from) <= MAIL_RANGE_MAX_DAYS * 86_400_000,
  );
const mailRangeMessage = {
  message: 'a range needs from and to, in order, within a year',
};

export const opsMailPeriodQuerySchema = z
  .object(mailPeriodFields)
  .refine(validMailRange, mailRangeMessage);

const mailListFields = {
  ...mailPeriodFields,
  type: z
    .string()
    .regex(/^[a-z0-9_]{1,60}$/)
    .optional(),
  status: z
    .string()
    .regex(/^[a-z_]{1,20}$/)
    .optional(),
  provider: mailProviderNameSchema.optional(),
  account: z.string().trim().min(1).max(64).optional(),
};

export const opsMailListQuerySchema = z
  .object({ ...mailListFields, cursor: z.string().max(100).optional() })
  .refine(validMailRange, mailRangeMessage);

export const opsMailExportQuerySchema = z
  .object({ ...mailListFields, kind: z.enum(['summary', 'messages']) })
  .refine(validMailRange, mailRangeMessage);

export interface OpsMailTotal {
  count: number;
  previous: number;
  /** Null when the previous period was zero. */
  changePct: number | null;
}

export interface OpsMailSummary {
  range: { from: string; to: string };
  previous: { from: string; to: string };
  totals: Record<
    | 'sent'
    | 'delivered'
    | 'bounced'
    | 'complained'
    | 'opened'
    | 'clicked'
    | 'failed',
    OpsMailTotal
  >;
  rates: {
    delivery: number | null;
    open: number | null;
    click: number | null;
  };
  byType: { type: string; sent: number; previous: number }[];
  byProvider: { provider: string; sent: number; previous: number }[];
  byCategory: { category: string; sent: number; previous: number }[];
  /** Every type with any activity in the period, including ones that only failed. */
  types: string[];
  /** How long the oldest waiting email has been queued, in seconds. */
  queueAgeSeconds: number;
}

export interface OpsMailSeriesPoint {
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  opened: number;
  clicked: number;
  failed: number;
  previousSent: number;
}

export interface OpsMailRow {
  id: string;
  createdAt: string;
  type: string;
  category: string;
  toHint: string;
  userId: string | null;
  handle: string | null;
  provider: string | null;
  providerMessageId: string | null;
  status: string;
  lastEvent: string | null;
}

export interface OpsMailTimelineEvent {
  kind: string;
  provider: string | null;
  linkKey: string | null;
  occurredAt: string;
}

export type OpsMailContent =
  | { status: 'ok'; subject: string; html: string; text: string }
  | { status: 'withheld' };

// ---- Staff email recovery (mail platform spec §8.5) ----

export const opsEmailRecoverySchema = opsReasonSchema
  .extend({
    newEmail: z.email().max(254),
    // What was checked to be sure who this is; goes in the audit log.
    checks: z.string().trim().min(10).max(500),
  })
  .strict();
export type OpsEmailRecoveryRequest = z.infer<typeof opsEmailRecoverySchema>;

// Custom roles and per-person access (admin roles plan, Task 2).

const opsPermissionList = z
  .array(z.enum(OPS_PERMISSIONS))
  .max(OPS_PERMISSIONS.length)
  .refine((list) => new Set(list).size === list.length, 'repeated permission');
const opsRoleName = z.string().trim().min(2).max(60);
const opsRoleDescription = z.string().trim().max(300);

/** A new role starts with nothing ticked. */
export const opsRoleCreateSchema = opsReasonSchema.extend({
  name: opsRoleName,
  description: opsRoleDescription.default(''),
  permissions: opsPermissionList.default([]),
});
export type OpsRoleCreateRequest = z.infer<typeof opsRoleCreateSchema>;

export const opsRoleUpdateSchema = opsReasonSchema
  .extend({
    name: opsRoleName.optional(),
    description: opsRoleDescription.optional(),
    permissions: opsPermissionList.optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.permissions !== undefined,
    'nothing to change',
  );
export type OpsRoleUpdateRequest = z.infer<typeof opsRoleUpdateSchema>;

export const opsRoleImpactSchema = z
  .object({ permissions: opsPermissionList })
  .strict();
export type OpsRoleImpactRequest = z.infer<typeof opsRoleImpactSchema>;

/** The person's full list of adjustments: it replaces what they had. */
export const opsPersonalAccessSchema = opsReasonSchema
  .extend({ additions: opsPermissionList, removals: opsPermissionList })
  .refine(
    (body) => !body.additions.some((p) => body.removals.includes(p)),
    'a permission cannot be both added and removed',
  );
export type OpsPersonalAccessRequest = z.infer<typeof opsPersonalAccessSchema>;

export const opsChangeRoleSchema = opsReasonSchema.extend({
  roleId: z.string().min(1).max(64),
});
export type OpsChangeRoleRequest = z.infer<typeof opsChangeRoleSchema>;

export interface OpsRole {
  id: string;
  name: string;
  description: string;
  /** Built in: `owner` and `release_check`, which can't be edited or deleted. */
  system: boolean;
  permissions: string[];
  /** Active staff on this role. */
  people: number;
}

export interface OpsEffectiveAccess {
  roleId: string;
  permissions: string[];
  additions: string[];
  removals: string[];
}

/** What a role edit would do; a person is listed only if their access would really change. */
export interface OpsRoleImpact {
  roleId: string;
  added: string[];
  removed: string[];
  affected: {
    userId: string;
    email: string | null;
    gains: string[];
    losses: string[];
  }[];
}

export interface OpsRoleUpdated {
  role: OpsRole;
  affected: OpsRoleImpact['affected'];
}

export const opsAddStaffSchema = opsReasonSchema
  .extend({
    email: z.string().trim().min(3).max(254),
    roleId: z.string().min(1).max(100),
  })
  .strict();
export type OpsAddStaffRequest = z.infer<typeof opsAddStaffSchema>;

/** The enrolment code goes only to the person, by email. */
export interface OpsStaffAdded {
  userId: string;
  roleId: string;
  enrolmentExpiresAt: string;
  /** 'suppressed': the address is known not to accept mail, so the link won't arrive. */
  delivery: OpsInvitationDelivery;
}

export type OpsInvitationDelivery = 'queued' | 'suppressed';

export interface OpsEnrolmentLinkSent {
  enrolmentExpiresAt: string;
  delivery: OpsInvitationDelivery;
}

export interface OpsStaffPerson {
  userId: string;
  email: string | null;
  roleId: string;
  roleName: string;
  grantedAt: string;
  enrolled: boolean;
  /** The newest link's email state and whether it can still be used; null once enrolled. */
  invitation: { status: string; linkOpen: boolean } | null;
  permissions: string[];
  additions: string[];
  removals: string[];
}
