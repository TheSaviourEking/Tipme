import { z } from 'zod';
import type { WebVitalSummary } from './analytics.js';
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
  | { state: 'needs_enrolment' }
  | { state: 'needs_code' }
  | { state: 'granted'; role: string; permissions: string[] };

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

export const ISSUE_KINDS = [
  'payment_mismatch',
  'payment_conflict',
  'payment_unresolved',
  'payment_attempt_unresolved',
  'payment_account_unresolved',
  'payment_reversed',
  'payment_settlement_currency',
  'payout_failed',
  'payout_conflict',
  'provider_event_conflict',
  'stuck_tip',
  'unmatched_event',
  'pending_recovery',
  'message_reported',
  'profile_reported',
] as const;
export type OpsIssueKind = (typeof ISSUE_KINDS)[number];
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
  providerEventRowId?: string;
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

/** Every metrics answer says whether anonymous collection is on (off in production until D-07). */
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
  handle: string;
  displayName: string;
  plan: 'free' | 'pro';
  pageState: 'live' | 'not_live' | 'deleted';
  suspended: boolean;
}

/** Making a page Pro or Free again: always with a written reason (audited). */
export const opsPagePlanSchema = opsReasonSchema
  .extend({ plan: z.enum(['free', 'pro']) })
  .strict();
export type OpsPagePlanRequest = z.infer<typeof opsPagePlanSchema>;

/** One page's pricing for staff (ADR-0014): a staff-set share, or null for the policy's 10%. */
export interface OpsPagePricing {
  customFeeBps: number | null;
  feeFreeRemaining: number;
}

/** Staff set one page's TipMe fee in basis points (1000 = 10%), or clear it with null (ADR-0014). */
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
