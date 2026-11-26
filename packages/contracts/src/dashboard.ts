import { z } from 'zod';
import type { TipPurpose } from './checkout.js';

/** What a recipient's dashboard shows. Amounts are decimal strings of minor units. */
export interface DashboardSummary {
  currency: string;
  availableMinor: string;
  confirmingMinor: string;
  /**
   * You collect: money TipMe holds for the recipient, never part of `availableMinor` and never
   * withdrawable until it arrives. Before they are verified it is `keptMinor` ("Kept for you until
   * you add your bank details"); after, `onItsWayMinor` ("On its way to you"). "0" for everyone else.
   * What is held while a refund of one of their tips is settled is neither: `refundHeldMinor`
   * ("Held while a refund is settled"). The words are `COLLECT_HELD_WORDS`.
   */
  keptMinor: string;
  onItsWayMinor: string;
  refundHeldMinor: string;
  today: string;
  yesterday: string;
  thisWeek: string;
  lastWeek: string;
  last7Days: { date: string; netMinor: string }[];
  /** False when part of the balance was collected by a provider TipMe cannot pay out through yet. */
  withdrawalsAvailable: boolean;
}

/**
 * Browsing sessions that opened the owner's page today (Lagos day), from the anonymous analytics
 * events only; null while analytics are off, so no misleading zero is shown.
 */
export interface VisitsToday {
  visits: number | null;
}

export type TipState = 'paid' | 'confirming' | 'failed' | 'cancelled';

export interface MyTipRow {
  tipId: string;
  at: string;
  supporterLabel: string | null;
  hasMessage: boolean;
  grossMinor: string;
  netMinor: string;
  state: TipState;
}

export interface MyTipDetail {
  tipId: string;
  state: TipState;
  at: string;
  supporterLabel: string | null;
  /** Why the supporter tipped; shown with a paid tip only. */
  purpose: TipPurpose | null;
  message: string | null;
  /** The recipient hid this message (PR-011); its text is no longer returned. */
  messageHidden: boolean;
  /** The recipient reported it to TipMe. */
  messageReported: boolean;
  currency: string;
  grossMinor: string;
  platformFeeMinor: string;
  providerFeeMinor: string;
  netMinor: string;
  feePolicyVersion: string;
  proof: {
    verified: boolean;
    provider: string | null;
    referenceTail: string | null;
    verifiedAt: string | null;
    ledgerTransactionId: string | null;
  };
}

export interface ActivityRow {
  kind: 'tip' | 'withdrawal';
  id: string;
  at: string;
  amountMinor: string;
  state: string;
  supporterLabel: string | null;
  /** The bank a withdrawal went to, as recorded when it was requested. Null for tips. */
  bank: WithdrawalBank | null;
}

/** The bank a withdrawal was sent to, as recorded when it was requested. Never the current bank. */
export interface WithdrawalBank {
  bankName: string;
  last4: string;
}

export type WithdrawalState =
  'requested' | 'processing' | 'in_review' | 'sent' | 'failed' | 'reversed';

export interface WithdrawalRow {
  payoutId: string;
  /** When it was requested (the list's order and cursor). */
  requestedAt: string;
  /** When it was paid, if it was. */
  paidAt: string | null;
  currency: string;
  amountMinor: string;
  state: WithdrawalState;
  /** Null for a payout recorded without a destination (before banks were kept, or pretend). */
  bank: WithdrawalBank | null;
  /**
   * A request paid as parts across providers: every part's amount and state, in order, failed ones
   * included. Null when one payout paid it; then `amountMinor` and `state` are that payout's. For
   * parts, `amountMinor` is the sum of the parts that have not failed (a failed part's money is back
   * in the balance), or of all of them when every part failed. `state` comes from the parts that
   * have not failed: `sent` only when all of those are sent, otherwise the least advanced of them;
   * `failed` only when every part failed. `paidAt` is set only when every part not failed is sent.
   * Never names a provider.
   */
  parts: { amountMinor: string; state: WithdrawalState }[] | null;
}

/**
 * What `POST /v1/me/withdrawals` (and a business's) answers: the request's payouts, in order.
 * `payoutId` is part 1, or the only payout; `groupId` is null when one payout carries it all.
 * Amounts are minor units of NGN; never names a provider.
 */
export interface WithdrawalRequestResult {
  payoutId: string;
  status: string;
  groupId: string | null;
  parts: { payoutId: string; amountMinor: string; status: string }[];
}

export interface WithdrawalsPage {
  items: WithdrawalRow[];
  nextCursor: string | null;
}

export const myWithdrawalsQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

/** Only tips with a note the recipient can read. */
export const myTipsNoteSchema = z.enum(['with']);

/** Every tip ever paid to the recipient. Tips still being confirmed are not counted. */
export interface TipTotals {
  currency: string;
  /** Sum of what the recipient received (net of the TipMe fee each tip recorded) from paid tips. */
  receivedNetMinor: string;
  /** Number of paid tips. TipMe keeps no supporter identity, so this is not a count of people. */
  paidTipCount: number;
}

/**
 * `feePaidBy` is who the quote on screen showed paying the transfer fee (Ruling R6, profit guards):
 * when the request decides otherwise it is refused `WITHDRAWAL_FEE_CHANGED`, so nobody is charged a
 * fee they did not see. Optional for one release so a screen loaded before it still works: without
 * it the request decides the payer as it always has.
 */
export const withdrawalRequestSchema = z
  .object({
    amountMinor: z.string().regex(/^\d{1,12}$/),
    feePaidBy: z.enum(['user', 'tipme']).optional(),
  })
  .strict();

/** What the recipient can withdraw now and, if nothing, why. Amounts are minor units of NGN. */
export type WithdrawalQuote =
  | {
      state: 'ready';
      withdrawableMinor: string;
      ledgerMinor: string;
      providerMinor: string;
      /** The transfer fee the user pays on a withdrawal: '0' when TipMe pays it. */
      feeMinor: string;
      /**
       * What each part of a full withdrawal would be, in the order they are paid, when the balance
       * is held in more than one place: more than one entry means it may arrive as that many
       * payments. Amounts only.
       */
      capsMinor: string[];
      /** Some of the balance can't be withdrawn right now; the rest can. Try again later. */
      partial: boolean;
      /** Adding the bank details again would make all of the balance withdrawable. */
      bankDetailsNeeded: boolean;
      /** Some money is held where withdrawals can't reach it now; it isn't in this quote. */
      heldElsewhere: boolean;
      /**
       * Who pays the partner's fee. 'user' by default, for a person (owner, 25 Nov 2026; it replaces
       * 18 Nov's two free a day) and a business (since 12 Nov 2026): the fee comes off the amount
       * chosen (withdrawing ₦10,000 receives ₦9,950). 'tipme' only when an unused top-up TipMe already
       * sent to the account can pay it, or, for a business, while the `business_payout_fee_absorbed`
       * switch is on. The request sends it back (Ruling R6) so a change since is refused.
       */
      feePaidBy: 'user' | 'tipme';
      /**
       * A person's page: which withdrawal of the Lagos day this one would be (not counting failed
       * ones). A business: 1. Nothing reads it to price a withdrawal now.
       */
      ordinalToday: number;
      /** Always 0: nobody has free withdrawals (owner, 25 Nov 2026). Kept for older screens. */
      freePerDay: number;
      destination: { bankName: string; last4: string };
    }
  | { state: 'setup_needed'; requirementsDue: string[]; onboardingUrl?: string }
  | { state: 'no_destination' }
  | { state: 'destination_pending' }
  // `review` covers holds whose cause staff keep to themselves (a reported account takeover).
  | {
      state: 'paused';
      reason:
        | 'reversal'
        | 'in_debt'
        | 'unexpected_payout'
        | 'review'
        | 'switched_off';
    }
  | { state: 'provider_unavailable' };

/** The quote, and whether the provider itself is checking a withdrawal already under way. */
export type WithdrawalQuoteResponse = WithdrawalQuote & { inReview: boolean };

/**
 * `GET /v1/me/withdrawal-quote?scope=local`, what a live update reads: only what TipMe's own
 * records decide, so a signal never makes a call to the payment partner. `unchecked` means
 * nothing on TipMe's side stops a withdrawal; how much can go needs the full quote.
 */
export const withdrawalQuoteQuerySchema = z
  .object({ scope: z.enum(['local']).optional() })
  .strict();
export type WithdrawalQuoteLocalResponse =
  WithdrawalQuoteResponse | { state: 'unchecked'; inReview: boolean };

export interface NotificationView {
  id: string;
  kind: string;
  tipId: string | null;
  momentId: string | null;
  reportId: string | null;
  /** A business invitation (kind `business_invitation`): it is answered on the Work page. */
  invitationId: string | null;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

/** A recipient's week. `topSupporterLabel` is private: it never goes into anything shareable. */
export interface WeeklyReportData {
  week: string;
  totalNetMinor: string;
  changePct: number | null;
  tipCount: number;
  notesCount: number;
  bestDay: { date: string; netMinor: string } | null;
  topSupporterLabel: string | null;
  moments: { key: string; title: string }[];
}

export interface MomentView {
  id: string;
  key: string;
  kind: string;
  title: string;
  sharedAt: string | null;
  createdAt: string;
}

/** A recipient reports a supporter's message (PR-011). */
export const messageReportSchema = z
  .object({ reason: z.enum(['abusive', 'spam', 'other']) })
  .strict();
export type MessageReportReason = z.infer<typeof messageReportSchema>['reason'];
