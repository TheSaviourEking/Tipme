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
  /** Paid Pro (ADR-0015): checkouts on TipMe's own account, with no connected account. */
  platformCheckout?: boolean;
}

/**
 * Whose money an event is about. Absent: a connected account's (a tip), as every event was before
 * paid Pro. `platform`: TipMe's own account (a Pro purchase), routed only to Pro billing.
 */
export type ProviderEventScope = 'platform';

export type PayoutFailureReason = 'in_debt' | 'destination' | 'other';

export type NormalizedProviderEvent =
  | {
      kind: 'payment';
      eventId: string;
      eventType: string;
      scope?: ProviderEventScope;
      providerReference: string | null;
      operationReference: string | null;
      accountReference: string | null;
      /** TipMe's own account: the partner's payment (charge) id, when the event names one. */
      chargeReference?: string | null;
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
      scope?: ProviderEventScope;
      /** Null only for TipMe's own account (`scope: 'platform'`). */
      accountReference: string | null;
      providerReference: string | null;
      operationReference: string | null;
      /** TipMe's own account: the charge refunded or disputed, when the event names it. */
      chargeReference?: string | null;
      /**
       * The partner's refund or dispute this event is about, as `refund.<id>` or `dispute.<id>`.
       * Several events for one refund or dispute (created, processed, lost) share it, so they key
       * one reversal (R2-A). Null when the payload names none: staff can't reverse it from TipMe.
       */
      partnerReversalId: string | null;
      /** A dispute decided in the merchant's favour: nothing is taken back, nothing to reverse. */
      disputeWon: boolean;
      /**
       * A refund's state, from its event (the partner's refund guide): `refund.created` is
       * accepted and processing, `refund.paid` and `refund.failed` are final. Null for any other
       * event. Only a paid refund can be reversed.
       */
      refundState: 'pending' | 'paid' | 'failed' | null;
      /** What a paid refund gave back (`refunded_amount`), in minor units; null until paid. */
      refundedMinor: bigint | null;
      /** A fee the refund itself carries (`refund_fee_amount`), in minor units. */
      refundFeeMinor: bigint | null;
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
      /** The signed event disagrees with itself: only a read of the payout may decide. */
      contradicted?: true;
      /** What the event says the payout is, to compare with what TipMe asked for. */
      amountMinor?: bigint;
      currency?: string;
      /** The reference TipMe set when it created the payout: its own payout id. */
      operationReference?: string;
      feeMinor?: bigint;
    }
  | {
      /**
       * Auto-renew (plan Task 10): a card saved on TipMe's own account while paying. The partner's
       * ids only; card details never leave the adapter.
       */
      kind: 'saved_method';
      eventId: string;
      eventType: 'payment_method.saved';
      customerReference: string;
      paymentMethodReference: string;
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
  /**
   * Paid Pro (ADR-0015): a checkout on TipMe's own account for one purchase, with no connected
   * account and no platform fee. The price is the server's. Raises PlatformCheckoutUnavailableError
   * when the provider definitely refuses TipMe's account, UncertainProviderOutcomeError when the
   * outcome is unknown.
   */
  initializePlatformCheckout?(input: {
    purchaseId: string;
    amountMinor: bigint;
    currency: 'NGN';
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
    /** Auto-renew opt-in: save the card on this customer while paying (NGN cards only). */
    saveCard?: { customerReference: string };
  }): Promise<{
    providerReference: string;
    checkoutUrl: string;
    expiresAt: Date;
  }>;
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
    /** How it was paid, when the provider says (TipMe's own checkouts: card or bank transfer). */
    method?: 'NGN_CARD' | 'NGN_BANK_TRANSFER';
    /** TipMe's own account: the partner's payment (charge) id, which a refund names. */
    chargeReference?: string;
    /** Pretend provider only: the card it saved while paying (the real one says so by webhook). */
    savedMethod?: { customerReference: string; paymentMethodReference: string };
  }>;
  /**
   * Paid Pro refunds (plan Task 9): refunds a charge on TipMe's own account, once per payment.
   * Raises ProRefundRefusedError when the partner definitely refused (nothing was created) and
   * UncertainProviderOutcomeError when the answer is unknown.
   */
  refundPlatformCharge?(input: {
    chargeReference: string;
    amountMinor: bigint;
    reference: string;
    idempotencyKey: string;
  }): Promise<{
    refundReference: string;
    status: 'processing' | 'paid' | 'failed';
  }>;
  /** Auto-renew: a customer on TipMe's own account, to save a card on. */
  createPlatformCustomer?(input: {
    email: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ customerReference: string }>;
  /**
   * Auto-renew: charges a saved card off-session, once per key. `pending` (processing) is never
   * success. Raises SavedCardRefusedError when nothing can be charged (no or unusable card).
   */
  chargeSavedCard?(input: {
    customerReference: string;
    paymentMethodReference: string;
    amountMinor: bigint;
    currency: 'NGN';
    reference: string;
    idempotencyKey: string;
  }): Promise<{
    providerReference: string;
    status: 'succeeded' | 'pending' | 'failed';
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
  /** Adds what paying out needs to an account made without it. The state comes from payoutCapability. */
  requestPayoutCapabilities(accountRef: string): Promise<void>;
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
  /**
   * Where a destination's review stands now. An add can replay an old answer (its key is fixed), and
   * review can end long after it. Only a stated rejection is 'rejected'; a failed read, including
   * not found, throws and says nothing about the destination.
   */
  payoutDestinationStatus(
    accountRef: string,
    destinationRef: string,
  ): Promise<'usable' | 'pending_review' | 'rejected'>;
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
  /**
   * Paid Pro from the balance (plan Task 8): moves the account's AVAILABLE balance to TipMe's own
   * (`destination: "self"`). It can't be reversed. PayoutRejectedError (in debt, short) and
   * PlatformRefusalError (the account's transfers capability, or the key) are definite;
   * UncertainProviderOutcomeError is not.
   */
  collectToPlatform?(input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
    /** What the transfer says it is for; 'TipMe Pro' unless given. */
    description?: string;
  }): Promise<{ transferRef: string; status: 'paid' | 'pending' }>;
  /**
   * Business release 2, option B: TipMe's own balance to an account (`POST /v1/transfers` as the
   * platform, `transfer_group` = the key, so `findPlatformCollection` reads it back). It can't be
   * reversed. PlatformRefusalError (TipMe's balance or key) and PayoutRejectedError are definite;
   * UncertainProviderOutcomeError is not. The partner refuses account-to-account transfers, so
   * there is deliberately no such call: a move between two accounts is always two transfers.
   */
  transferToAccount?(input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
    description: string;
  }): Promise<{ transferRef: string; status: 'paid' | 'pending' }>;
  /**
   * The read-back for a collect whose answer was lost: the account's transfer with this key as its
   * group, or null when none is listed. Anything unclear raises UncertainProviderOutcomeError.
   */
  findPlatformCollection?(
    accountRef: string,
    idempotencyKey: string,
  ): Promise<{
    transferRef: string;
    status: 'paid' | 'pending';
    amountMinor: bigint;
    currency: string;
  } | null>;
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
    /** What the provider actually charged, when it says. It can differ from the quote. */
    feeMinor?: bigint;
  }>;
  /** Server-to-server payout status: the authority for payout reconciliation. */
  fetchPayoutStatus(providerReference: string): Promise<{
    status: 'paid' | 'failed' | 'pending' | 'review' | 'not_found';
    failureReason?: PayoutFailureReason;
    feeMinor?: bigint;
    /** What the provider says this payout is, to compare with what TipMe asked for. */
    amountMinor?: bigint;
    currency?: string;
    destinationRef?: string;
    /** The reference TipMe set when it created the payout. */
    operationReference?: string;
  }>;
  /**
   * Finds the payout a lost answer may have created. Null means the provider has none right now;
   * anything unclear raises UncertainProviderOutcomeError. A null soon after a timed-out create is
   * not proof, because that request may still be in flight: act on null only once the attempt is
   * older than an age threshold. The account is required because a provider searches the caller's
   * own payouts: without it, the answer would be a false "none".
   */
  findPayoutByReference(
    accountRef: string,
    payoutId: string,
  ): Promise<{
    providerReference: string;
    status: 'paid' | 'failed' | 'pending' | 'review';
    failureReason?: PayoutFailureReason;
    feeMinor?: bigint;
    amountMinor?: bigint;
    currency?: string;
    destinationRef?: string;
    operationReference?: string;
  } | null>;
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

/**
 * The provider definitely refused TipMe itself, not the recipient: the reserve can't cover a top-up,
 * or the key was refused. No money moved, and the withdrawal waits rather than fails.
 */
export class PlatformRefusalError extends Error {
  constructor(
    readonly refusal: 'reserve_empty' | 'provider_key',
    readonly providerCode?: string,
  ) {
    super('The payment provider refused the platform');
    this.name = 'PlatformRefusalError';
  }
}

/**
 * The provider definitely refused a checkout on TipMe's own account (e.g. the account isn't
 * activated for live payments): nothing was created, and nobody can pay this way right now.
 */
export class PlatformCheckoutUnavailableError extends Error {
  constructor(readonly providerCode?: string) {
    super('The payment provider refused a checkout on TipMe’s own account');
    this.name = 'PlatformCheckoutUnavailableError';
  }
}

/** The partner definitely refused a Pro refund (not refundable, no balance): nothing was created. */
export class ProRefundRefusedError extends Error {
  constructor(readonly providerCode?: string) {
    super('The payment provider refused the refund');
    this.name = 'ProRefundRefusedError';
  }
}

/** The saved card can't be charged at all (none saved, removed, expired): nothing was charged. */
export class SavedCardRefusedError extends Error {
  constructor(readonly providerCode?: string) {
    super('The payment provider refused to charge the saved card');
    this.name = 'SavedCardRefusedError';
  }
}

export class UnsupportedProviderCapabilityError extends Error {
  constructor(capability: string) {
    super(`Payment provider does not support ${capability}`);
    this.name = 'UnsupportedProviderCapabilityError';
  }
}
