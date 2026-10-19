import { z } from 'zod';

export const mockWebhookTypes = [
  'payment.pending',
  'payment.succeeded',
  'payment.failed',
  'payout.processing',
  'payout.paid',
  'payout.failed',
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
      })
      .strict(),
  })
  .strict();
export type MockWebhook = z.infer<typeof mockWebhookSchema>;
