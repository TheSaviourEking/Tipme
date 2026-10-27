export type TransactionStatus =
  'succeeded' | 'failed' | 'pending' | 'not_found';

export type FeePaidBy =
  'platform' | 'connected_account' | 'customer' | 'unknown';

export interface ProviderCapabilities {
  hostedCheckout: boolean;
  connectedAccounts: boolean;
  platformFees: boolean;
  payouts: boolean;
  lookupByOperationReference: boolean;
}

export type NormalizedProviderEvent =
  | {
      kind: 'payment';
      eventId: string;
      eventType: string;
      providerReference: string | null;
      operationReference: string | null;
      accountReference: string | null;
      status: 'succeeded' | 'failed' | 'pending' | 'review' | 'unknown';
      amountMinor?: bigint;
      expectedAmountMinor?: bigint;
      currency?: string;
      feeMinor?: bigint;
      feePaidBy: FeePaidBy;
    }
  | {
      kind: 'ignored';
      eventId: string;
      eventType: string;
    };

export type WebhookVerification<TEvent = NormalizedProviderEvent> =
  | { ok: true; event: TEvent }
  | {
      ok: false;
      reason: 'missing_signature' | 'bad_signature' | 'stale' | 'malformed';
    };

/**
 * What every payment provider adapter must offer (subset of PRD 6.5). Provider-specific formats
 * (signatures, status names, references) stay inside each adapter.
 */
export interface PaymentProvider<TWebhookEvent = NormalizedProviderEvent> {
  name: string;
  capabilities?: ProviderCapabilities;
  /**
   * Starts a payment with a stable operation reference. An ambiguous provider response remains
   * unknown unless that provider can authoritatively resolve it.
   */
  initializePayment(input: {
    attemptId: string;
    amountMinor: bigint;
    currency: string;
    recipientAccountReference?: string;
    tipmeShareMinor?: bigint;
    successUrl?: string;
    cancelUrl?: string;
    idempotencyKey?: string;
  }): Promise<{ providerReference: string; checkoutUrl?: string }>;
  /** Returns null only for a definite absence; unsupported lookup must fail as uncertain. */
  findPayment(attemptId: string): Promise<{ providerReference: string } | null>;
  /** Server-to-server status check: the authority for reconciliation. */
  verifyTransaction(providerReference: string): Promise<{
    status: TransactionStatus;
    amountMinor: bigint;
    currency: string;
    feeMinor: bigint;
    feePaidBy?: FeePaidBy;
  }>;
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now?: Date,
  ): WebhookVerification<TWebhookEvent>;
  /** Server-to-server payout status: the authority for payout reconciliation. */
  fetchPayoutStatus(providerReference: string): Promise<{
    status: 'paid' | 'failed' | 'pending' | 'not_found';
  }>;
  /** Repeated requests with the same key must resolve to the same provider payout. */
  initiatePayout(input: {
    payoutId: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    recipientAccountReference?: string;
    payoutDestinationReference?: string;
  }): Promise<{ providerReference: string }>;
}

export class UnsupportedProviderCapabilityError extends Error {
  constructor(capability: string) {
    super(`Payment provider does not support ${capability}`);
    this.name = 'UnsupportedProviderCapabilityError';
  }
}
