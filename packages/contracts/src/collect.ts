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

// COLLECT_COPY lives in copy.ts (no zod), so public pages can import it on its own.
export { COLLECT_COPY, COLLECT_HELD_WORDS } from './copy.js';
