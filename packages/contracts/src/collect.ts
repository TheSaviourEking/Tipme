import { z } from 'zod';
import { opsReasonSchema } from './ops.js';
import {
  accountNumberSchema,
  bankCodeSchema,
  emailCodeSchema,
} from './payment-accounts.js';

/**
 * You collect (ADR-0016, PROPOSED; spec §2, §8, §9): TipMe takes a new recipient's tips on its own
 * account and holds each share until they add bank details. Amounts are decimal strings of minor
 * units; the server is the only source of them.
 */

/**
 * A recipient's You collect state (plan Task 12; read by `GET /v1/me/collect`, Task 13). `heldMinor`
 * is what TipMe holds for them now: `keptMinor` while they have no verified bank details ("Kept for
 * you until you add your bank details"), `onItsWayMinor` once verified ("On its way to you"), and
 * `refundHeldMinor` for the part held while a refund of one of their tips is settled ("Held while a
 * refund is settled"); none is withdrawable yet. The page pauses at the holding cap (`pausedReason`) until they
 * are verified; `pauseOn` is when the days part of the cap is reached. The two withdrawal limits are
 * null when they don't apply (a direct recipient, a first withdrawal since verification already made,
 * or more than the setting's days since verification).
 */
export interface CollectStatus {
  mode: 'direct' | 'collect';
  verified: boolean;
  heldMinor: string;
  keptMinor: string;
  onItsWayMinor: string;
  refundHeldMinor: string;
  firstWaitingAt: string | null;
  paused: boolean;
  pausedReason: 'amount' | 'days' | null;
  pauseOn: string | null;
  firstWithdrawalCapMinor: string | null;
  dailyLimitMinor: string | null;
}

/** The settings as staff read and send them (spec §9). */
export interface OpsCollectSettingsValues {
  /** The holding cap: the most held for one recipient without bank details. */
  capMinor: string;
  capDays: number;
  /** Days after the first waiting tip on which the recipient is reminded, ascending. */
  reminderDays: number[];
  /** The new-recipient delay: hours each share waits, for this many days after sign-up. */
  delayHours: number;
  delayForDays: number;
  firstWithdrawalCapMinor: string;
  /** A new account's limit per Lagos day, for this many days after sign-up. */
  newDailyLimitMinor: string;
  newDailyLimitDays: number;
  /** TipMe's own money above what it holds for recipients: alert levels, critical below warning. */
  reserveWarningMinor: string;
  reserveCriticalMinor: string;
}

export interface OpsCollectSettingsRow extends OpsCollectSettingsValues {
  id: string;
  paused: boolean;
  effectiveFrom: string;
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: string;
}

/**
 * `GET /v1/ops/collect-settings`: the settings in force (a stored row, or the coded defaults), their
 * history, the minimum withdrawal (the floor of the first-withdrawal cap), and a change, pause or
 * resume still waiting for a second person.
 */
export interface OpsCollectSettings {
  current: OpsCollectSettingsValues & {
    /** Staff paused every collect transfer (R11). */
    paused: boolean;
    source: 'setting' | 'default';
    effectiveFrom: string | null;
  };
  history: OpsCollectSettingsRow[];
  minWithdrawalMinor: string;
  waitingRequestId: string | null;
}

const minor = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);
const days = z.number().int().min(0).max(365);

/**
 * `POST /v1/ops/collect-settings`: the whole set, with a reason. The shape is checked here; the
 * bounds (§9), critical below warning, each reminder before the cap's last day and the first cap at
 * least the minimum withdrawal are the server's, in the serious action.
 */
export const opsCollectSettingsChangeSchema = opsReasonSchema
  .extend({
    capMinor: minor,
    capDays: days,
    reminderDays: z.array(days).min(1).max(10),
    delayHours: days,
    delayForDays: days,
    firstWithdrawalCapMinor: minor,
    newDailyLimitMinor: minor,
    newDailyLimitDays: days,
    reserveWarningMinor: minor,
    reserveCriticalMinor: minor,
  })
  .strict();
export type OpsCollectSettingsChangeRequest = z.infer<
  typeof opsCollectSettingsChangeSchema
>;

/**
 * One part of a recipient's legal name, as their bank has it (spec §2.1 step 4): letters (any
 * script), spaces, hyphens, apostrophes and full stops, starting with a letter.
 */
const legalNamePartSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^\p{L}[\p{L}\p{M} '’.-]*$/u);

/** Their legal name, first and last. Personal data: kept by TipMe, never logged or returned. */
export const collectLegalNameSchema = z
  .object({ first: legalNamePartSchema, last: legalNamePartSchema })
  .strict();
export type CollectLegalName = z.infer<typeof collectLegalNameSchema>;

/**
 * `POST /v1/me/collect/bank/lookup` (plan Task 13): the bank's name for the account, for "Is this
 * you? {BANK NAME}". Nothing is stored.
 */
export const collectBankLookupSchema = z
  .object({
    legalName: collectLegalNameSchema,
    bankCode: bankCodeSchema,
    accountNumber: accountNumberSchema,
  })
  .strict();
export type CollectBankLookupRequest = z.infer<typeof collectBankLookupSchema>;
export interface CollectBankLookupResponse {
  /** The name the bank holds for the account, as the bank spells it. */
  bankName: string;
}

/**
 * `POST /v1/me/collect/bank` (plan Task 13): the confirmed name and bank, sent to our payment
 * partner, who compares the bank's name with theirs. `emailCode` is the code sent to the account's
 * own verified address (`POST /v1/me/payout-destination/code`), as for any bank added to TipMe.
 */
export const collectBankAddSchema = collectBankLookupSchema
  .extend({ confirmed: z.literal(true), emailCode: emailCodeSchema })
  .strict();
export type CollectBankAddRequest = z.infer<typeof collectBankAddSchema>;

/**
 * Where the check stands: `verified` (names match and the account can receive: "You’re all set"),
 * `checking` (accepted, the account not ready yet: "We’re checking your details") or
 * `manual_review` (some words match, the partner's team checks it by hand). No match is refused
 * (`422 NAME_MISMATCH`) and nothing is saved.
 */
export type CollectBankState = 'verified' | 'checking' | 'manual_review';
export interface CollectBankAddResponse {
  state: CollectBankState;
}

/** All a recipient sees of their bank here: the bank's name and the last four digits. */
export interface CollectBankView {
  state: CollectBankState;
  last4: string;
  /** The bank (institution), not the account holder's name. */
  bankName: string;
}

/** `GET /v1/me/collect`: their You collect state, and their bank once added. */
export interface CollectStatusView extends CollectStatus {
  bank: CollectBankView | null;
  /**
   * What is held from their balance for disputes on their tips still open (spec §6.2), in minor
   * units, never negative: "A payment to you is being questioned. We’ve held {amount} until it's
   * settled." "0" when nothing is held.
   */
  disputeHeldMinor: string;
}

/**
 * Staff's `collect_name.change` (support, a second person): the recipient's verified legal name,
 * changed after support checked it. The name leaves the request once it is decided.
 */
export const opsCollectNameChangeSchema = opsReasonSchema
  .extend({ first: legalNamePartSchema, last: legalNamePartSchema })
  .strict();
export type OpsCollectNameChangeRequest = z.infer<
  typeof opsCollectNameChangeSchema
>;

/*
 * You collect staff screens (plan Task 15, spec §9). Today's masking rules: a recipient is their
 * handle, a bank account its last four digits, and nothing about a supporter appears. Amounts are
 * decimal strings of minor units.
 */

/** One recipient TipMe holds money for (its `held_for_recipients` on the ledger). */
export interface OpsCollectHeldRecipient {
  profileId: string;
  handle: string | null;
  heldMinor: string;
  currency: string;
  verified: boolean;
  /** When the oldest tip whose share TipMe still holds settled. */
  oldestTipAt: string | null;
  /** Whole days until the holding cap's days run out; null when it doesn't apply (verified). */
  daysLeft: number | null;
  remindersSent: number;
  paused: boolean;
  pausedReason: 'amount' | 'days' | null;
  /**
   * Fix round 1 (I3): support changed their verified name at this time, and nothing more moves to
   * them until our payment partner checks it with their bank details again. Null otherwise.
   */
  nameRecheckSince: string | null;
}

/** A business's share TipMe holds (R3), by name only. */
export interface OpsCollectHeldBusiness {
  businessId: string;
  name: string | null;
  heldMinor: string;
  currency: string;
}

/** `GET /v1/ops/collect/held`: per currency, the total is the ledger's own sum. */
export interface OpsCollectHeld {
  totals: { currency: string; heldMinor: string }[];
  recipients: OpsCollectHeldRecipient[];
  businesses: OpsCollectHeldBusiness[];
}

export const OPS_COLLECT_TRANSFER_STATUSES = [
  'waiting',
  'ready',
  'sent',
  'unknown',
  'review',
  'paid',
  'cancelled',
] as const;
export type OpsCollectTransferStatus =
  (typeof OPS_COLLECT_TRANSFER_STATUSES)[number];

/** One collect transfer. Never the partner account, only the group staff look up at the partner. */
export interface OpsCollectTransfer {
  id: string;
  kind: 'share' | 'back' | 'return';
  status: OpsCollectTransferStatus;
  reviewReason: string | null;
  handle: string | null;
  amountMinor: string;
  currency: string;
  /** The transfer's group at the partner (`tipme-collect-<tipId>` and kin). */
  group: string;
  /** The last four digits of the recipient's current bank, when known. */
  bankLast4: string | null;
  attempts: number;
  /** The partner definitely refused its last send (nothing moved). */
  refused: boolean;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A recipient whose transfers a shared bank account holds (`collect_same_bank`). */
export interface OpsCollectSameBank {
  profileId: string;
  handle: string | null;
  openIssues: number;
  heldTransfers: number;
  heldMinor: string;
  since: string | null;
}

export type OpsCollectEvidenceState =
  'none' | 'draft' | 'sending' | 'submitted' | 'refused';

export interface OpsCollectDispute {
  id: string;
  handle: string | null;
  amountMinor: string;
  currency: string;
  status: 'open' | 'responded' | 'won' | 'lost' | 'closed';
  /** The partner's reason code. */
  reason: string | null;
  respondBy: string | null;
  /** From TipMe's own records, never guessed from the status. */
  evidenceState: OpsCollectEvidenceState;
  heldMinor: string;
  settledAt: string | null;
  createdAt: string;
}

export interface OpsCollectDisputeDetail extends OpsCollectDispute {
  partnerDisputeId: string;
  shareStep: 'held' | 'balance' | 'none' | null;
  decidedAt: string | null;
  feeMinor: string | null;
  feeCurrency: string | null;
  evidence: {
    state: OpsCollectEvidenceState;
    files: { contentType: string; bytes: number }[];
    askedAt: string | null;
    submittedAt: string | null;
    /** Evidence can be added and sent now (open, before the deadline, not sent yet). */
    canSubmit: boolean;
    /** The most files this dispute's provider takes (1 at Bachs, 5 elsewhere). */
    maxFiles: number;
    /** The deadline has passed. */
    late: boolean;
  };
  /** A closed dispute's hold kept for a refund, releasable early (P28) when nothing uses it. */
  holdRelease: { possible: boolean; why: string | null };
}

/** A recipient past the holding cap (spec §15): for staff follow-up, nothing automatic. */
export interface OpsCollectUnclaimed {
  profileId: string;
  handle: string | null;
  heldMinor: string;
  currency: string;
  oldestTipAt: string | null;
  pausedReason: 'amount' | 'days';
  remindersSent: number;
}

/** `POST /v1/ops/collect/disputes/:id/evidence`: staff's words for the partner, and a reason. */
export const opsCollectEvidenceSchema = opsReasonSchema
  .extend({ text: z.string().trim().min(20).max(5000) })
  .strict();
export type OpsCollectEvidenceRequest = z.infer<
  typeof opsCollectEvidenceSchema
>;

/** The evidence files staff may add: PDF, PNG or JPEG, up to 5 MB each, five at most. */
export const OPS_COLLECT_EVIDENCE_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
] as const;
export const OPS_COLLECT_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const OPS_COLLECT_EVIDENCE_MAX_FILES = 5;
// The per-provider limit (one file at Bachs) is opsCollectEvidenceMaxFiles, in provider-names.ts.

/** `POST /v1/ops/collect/name`: a locked name changed by support, on the page with this handle. */
export const opsCollectNameRequestSchema = opsCollectNameChangeSchema
  .extend({ handle: z.string().trim().min(1).max(40) })
  .strict();
export type OpsCollectNameRequest = z.infer<typeof opsCollectNameRequestSchema>;

/** What a You collect staff action came to (a pending request answers 202 instead). */
export interface OpsCollectActed {
  done: true;
}

// COLLECT_COPY lives in copy.ts (no zod), so public pages can import it on its own.
export {
  COLLECT_COPY,
  COLLECT_HELD_NOTE,
  COLLECT_HELD_WORDS,
  COLLECT_NAME_RECHECK_NOTICE,
} from './copy.js';
