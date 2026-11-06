import { z } from 'zod';
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
  })
  .strict();
export type TipIntentRequest = z.infer<typeof tipIntentRequestSchema>;

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
}
