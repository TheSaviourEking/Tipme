import type { MockWebhook } from '@tipme/contracts';

export const SCENARIOS = [
  'succeed',
  'decline',
  'pending-then-succeed',
  'duplicate',
  'out-of-order',
  'wrong-amount',
  'no-reply',
  'forged',
  'payout-paid',
  'payout-failed',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type WebhookVerification =
  | { ok: true; event: MockWebhook }
  | {
      ok: false;
      reason: 'missing_signature' | 'bad_signature' | 'stale' | 'malformed';
    };

export type TransactionStatus =
  'succeeded' | 'failed' | 'pending' | 'not_found';

/**
 * What every payment provider adapter must offer (subset of PRD 6.5). Provider-specific formats
 * (signatures, status names, references) stay inside each adapter.
 */
export interface PaymentProvider {
  name: string;
  /**
   * Starts a payment, with TipMe's attempt id as the merchant reference. Idempotent per attempt:
   * a repeat (for example after a timeout) returns the same payment, never a second one.
   */
  initializePayment(input: {
    attemptId: string;
    amountMinor: bigint;
    currency: string;
    scenario?: Scenario;
  }): Promise<{ providerReference: string }>;
  /** The payment started for this attempt, if any: how a start that timed out is resolved. */
  findPayment(attemptId: string): Promise<{ providerReference: string } | null>;
  /** Server-to-server status check: the authority for reconciliation. */
  verifyTransaction(providerReference: string): Promise<{
    status: TransactionStatus;
    amountMinor: bigint;
    currency: string;
    feeMinor: bigint;
  }>;
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now?: Date,
  ): WebhookVerification;
  /** Server-to-server payout status: the authority for payout reconciliation. */
  fetchPayoutStatus(providerReference: string): Promise<{
    status: 'paid' | 'failed' | 'pending' | 'not_found';
  }>;
  initiatePayout(input: {
    payoutId: string;
    amountMinor: bigint;
    currency: string;
    scenario?: Scenario;
  }): Promise<{ providerReference: string }>;
}
