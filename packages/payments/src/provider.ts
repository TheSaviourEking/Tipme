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

export type PayoutFailureReason = 'in_debt' | 'destination' | 'other';

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
      kind: 'account';
      eventId: string;
      eventType: 'account.updated' | 'capability.updated';
      accountReference: string;
    }
  | {
      /** A refund, dispute or chargeback: money moving back. Never booked; staff review it. */
      kind: 'reversal';
      eventId: string;
      eventType: string;
      accountReference: string;
      providerReference: string | null;
      operationReference: string | null;
    }
  | {
      /** A payout reached a final state. A trigger only: it still goes through recordPayoutOutcome. */
      kind: 'payout';
      eventId: string;
      eventType: 'payout.paid' | 'payout.failed';
      providerReference: string;
      accountReference: string;
      status: 'paid' | 'failed';
      failureReason?: PayoutFailureReason;
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
export interface PaymentProvider<
  TWebhookEvent = NormalizedProviderEvent,
> extends Partial<PayoutPort> {
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
  verifyTransaction(
    providerReference: string,
    expectation?: { platformFeeMinor: bigint },
  ): Promise<{
    status: TransactionStatus;
    amountMinor: bigint;
    currency: string;
    feeMinor: bigint;
    feePaidBy?: FeePaidBy;
    platformFeeMinor?: bigint;
    /**
     * Set with `pending` when the provider has taken the money but its settlement evidence
     * (fee bearer, platform fee) is not final yet: the payment must never be expired.
     */
    collected?: true;
    /** Set when the provider settled the money in another currency than it was paid in. */
    settlementCurrency?: string;
  }>;
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now?: Date,
  ): WebhookVerification<TWebhookEvent>;
}

/**
 * Paying a recipient out, for providers with `capabilities.payouts`. Money writes raise
 * UncertainProviderOutcomeError when the outcome is unknown and PayoutRejectedError when the
 * provider definitely refused; nothing else is safe to read as "no money moved".
 */
export interface PayoutPort {
  /** Whether the account may pay out now. Requirements alone never mean it can. */
  payoutCapability(accountRef: string): Promise<{
    status: 'active' | 'restricted' | 'missing';
    requirementsDue: string[];
  }>;
  listBanks(country: 'NG'): Promise<{ code: string; name: string }[]>;
  /** Null when the number did not resolve: the recipient then types the account name. */
  resolveBankAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<{ accountName: string } | null>;
  addPayoutDestination(
    accountRef: string,
    input: { accountNumber: string; accountName: string; bankCode: string },
  ): Promise<{
    destinationRef: string;
    usable: boolean;
    status: 'usable' | 'pending_review' | 'rejected';
  }>;
  payoutBalance(
    accountRef: string,
    currency: 'NGN',
  ): Promise<{ availableMinor: bigint }>;
  platformBalance(currency: 'NGN'): Promise<{ availableMinor: bigint }>;
  quotePayoutFee(
    accountRef: string,
    amountMinor: bigint,
    currency: 'NGN',
  ): Promise<{ feeMinor: bigint; exact: boolean }>;
  /** Moves the payout fee from the platform balance to the account, ahead of the payout. */
  coverPayoutFee(input: {
    accountRef: string;
    feeMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
  }): Promise<{ transferRef: string }>;
  setManualPayouts(accountRef: string): Promise<void>;
  /** Repeated requests with the same key must resolve to the same provider payout. */
  initiatePayout(input: {
    payoutId: string;
    accountRef: string;
    destinationRef: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }): Promise<{
    providerReference: string;
    status: 'pending' | 'processing' | 'review';
  }>;
  /** Server-to-server payout status: the authority for payout reconciliation. */
  fetchPayoutStatus(providerReference: string): Promise<{
    status: 'paid' | 'failed' | 'pending' | 'review' | 'not_found';
    failureReason?: PayoutFailureReason;
  }>;
}

/** The provider definitely refused a payout or fee transfer: no money moved for this request. */
export class PayoutRejectedError extends Error {
  constructor(
    readonly failureReason: PayoutFailureReason,
    readonly providerCode?: string,
  ) {
    super('The payment provider refused the payout');
    this.name = 'PayoutRejectedError';
  }
}

export class UnsupportedProviderCapabilityError extends Error {
  constructor(capability: string) {
    super(`Payment provider does not support ${capability}`);
    this.name = 'UnsupportedProviderCapabilityError';
  }
}
