import { z } from 'zod';

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
] as const;
export type TipStatusState = (typeof tipStatusStates)[number];

/** What the status screen may show. Never includes the supporter's message. */
export interface TipStatusView {
  state: TipStatusState;
  recipient: { handle: string; displayName: string };
  amountMinor: string;
  currency: string;
  completedAt: string | null;
}
