import { z } from 'zod';

export const mockWebhookTypes = [
  'payment.pending',
  'payment.succeeded',
  'payment.failed',
  'payout.processing',
  'payout.paid',
  'payout.failed',
  // You collect (plan Task 5): disputes on TipMe's own account, and an account's capability change.
  'dispute.created',
  'dispute.updated',
  'capability.updated',
] as const;

/** A dispute's state in TipMe's words (the payment adapter's DisputeStatus). */
export const mockDisputeStatuses = [
  'open',
  'responded',
  'won',
  'lost',
  'closed',
] as const;

const minorString = z.string().regex(/^\d{1,19}$/);
// Printable identifiers only: control characters (e.g. NUL) could never be stored and would be retried forever.
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

/** The mock provider's webhook body. Amounts travel as decimal strings of minor units. */
export const mockWebhookSchema = z
  .object({
    id: identifier,
    type: z.enum(mockWebhookTypes),
    data: z
      .object({
        reference: identifier,
        attemptId: z.uuid().optional(),
        payoutId: z.uuid().optional(),
        amountMinor: minorString,
        currency: z.string().regex(/^[A-Z]{3}$/),
        feeMinor: minorString,
        // Dispute events only: the pretend partner reports its fee, unlike the real one's docs.
        disputeId: identifier.optional(),
        status: z.enum(mockDisputeStatuses).optional(),
        respondBy: z.iso.datetime().optional(),
        feeCurrency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        // capability.updated: the account whose capability changed.
        accountReference: identifier.optional(),
      })
      .strict(),
  })
  .strict();
export type MockWebhook = z.infer<typeof mockWebhookSchema>;
