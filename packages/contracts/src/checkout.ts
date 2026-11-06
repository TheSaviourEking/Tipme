import type { ShareDisclosure, TipBusinessNote } from './business.js';
import { z } from 'zod';
import { SUPPORTER_KEY_PATTERN } from './supporters.js';
import type { ThanksSlip } from './thanks.js';

/** Guest checkout wire shapes. Amounts travel as decimal strings of minor units; NGN only (illustrative). */
export const tipQuoteRequestSchema = z
  .object({
    handle: z.string().min(1).max(60),
    amountMinor: z.string().regex(/^\d{1,12}$/),
    currency: z.literal('NGN'),
  })
  .strict();
export type TipQuoteRequest = z.infer<typeof tipQuoteRequestSchema>;

export interface TipQuote {
  quoteId: string;
  handle: string;
  displayName: string;
  currency: string;
  tipMinor: string;
  platformFeeMinor: string;
  providerFeeMinor: string;
  recipientNetMinor: string;
  payerTotalMinor: string;
  expiresAt: string;
  feePolicyVersion: string;
  /** TipMe's fee is waived on this tip (a fee-free reward for the recipient). */
  feeFree: boolean;
  /**
   * Business release 2: the share agreed with the business the tip is made at, shown before
   * paying. Only with BUSINESS_SHARES_ENABLED, and only for a tip made at that business.
   */
  share?: ShareDisclosure;
}

/** Why the supporter is tipping. A closed list: it is stored, filtered and shown to the recipient. */
export const tipPurposes = [
  'thank_you',
  'great_service',
  'helped_me',
  'celebration',
  'gift',
  'other',
] as const;
export type TipPurpose = (typeof tipPurposes)[number];

// Hyphenated hex, any version: the same shape z.uuid() accepts in practice for our ids.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const tipIntentRequestSchema = z
  .object({
    quoteId: z.uuid(),
    message: z.string().max(280).optional(),
    payerDisplayLabel: z.string().max(60).optional(),
    purpose: z.enum(tipPurposes).optional(),
    celebrationMomentId: z.uuid().optional(),
    /**
     * The supporter agrees the recipient may show their note on their page. Only ever `true` or absent:
     * consent is never a default, and a request without a message stores none.
     */
    noteMayShow: z.literal(true).optional(),
    /**
     * "Let {recipient} recognise me next time": a random key this browser keeps for this recipient
     * only. Sent only when the supporter ticked the box and gave a name. The server stores its
     * SHA-256, and only for a Pro page while recognition is switched on; otherwise it is ignored.
     */
    supporterKey: z.string().regex(SUPPORTER_KEY_PATTERN).optional(),
    /**
     * The business membership the supporter's page named (TipMe for businesses). A label the
     * server checks and ignores when it doesn't hold: it never refuses or redirects a tip. So a
     * malformed one (not a uuid, not a string) is dropped here rather than refused (PR B4).
     */
    businessMemberId: z
      .unknown()
      .optional()
      .transform((value) =>
        typeof value === 'string' && UUID.test(value) ? value : undefined,
      )
      .meta({ type: 'string', format: 'uuid' }),
  })
  .strict();
export type TipIntentRequest = z.infer<typeof tipIntentRequestSchema>;

/**
 * Business release 2 (R2-D): paying a team quote. No message (it would reach several people) and
 * no member: the split is fixed from who is on shift when the tip is made.
 */
export const teamTipIntentRequestSchema = z
  .object({
    quoteId: z.uuid(),
    payerDisplayLabel: z.string().max(60).optional(),
    purpose: z.enum(tipPurposes).optional(),
  })
  .strict();
export type TeamTipIntentRequest = z.infer<typeof teamTipIntentRequestSchema>;

export interface TipIntentCreated {
  tipId: string;
  statusToken: string;
  checkoutUrl: string;
}

export const tipStatusStates = [
  'waiting',
  'paid',
  'declined',
  'checking',
  'cancelled',
  // The provider took the money; TipMe is still confirming its details (who bore the fee).
  'collected',
] as const;
export type TipStatusState = (typeof tipStatusStates)[number];

/** What the status screen may show. Never includes the supporter's message. */
export interface TipStatusView {
  state: TipStatusState;
  recipient: { handle: string; displayName: string };
  amountMinor: string;
  currency: string;
  completedAt: string | null;
  /**
   * What the supporter can quote to staff: the last 6 characters of the paid payment's reference,
   * uppercased. Null until the tip is paid. Never the whole reference.
   */
  reference: string | null;
  /**
   * Present (true) only when the tip is paid and its supporter agreed their note may be shown. The note
   * itself is never sent here.
   */
  noteMayShow?: true;
  /**
   * The recipient's thank-you, only when the tip is paid and the page has a line. It is the line as
   * it is now, not as it was when the tip was made (owner's answer, 5 Nov 2026).
   */
  thanks?: ThanksSlip;
  /**
   * Present (true) only when this paid tip is recognised: the supporter opted in and the page was
   * Pro. The receipt then offers "Stop {name} recognising me". Older APIs send nothing.
   */
  recognised?: true;
  /**
   * Only for a paid tip made at a business: whether the supporter's note about the person is still
   * open (7 days, once). Never carries the note.
   */
  businessNote?: TipBusinessNote;
  /** Business release 2: a team tip, shared equally among `people` on shift at `location`. */
  team?: { location: string; people: number };
  /** Business release 2: the share the business received of this tip, in percentages only. */
  share?: ShareDisclosure;
}
