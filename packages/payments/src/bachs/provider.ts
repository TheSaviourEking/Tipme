import { z } from 'zod';
import {
  PlatformCheckoutUnavailableError,
  ProRefundRefusedError,
  SavedCardRefusedError,
  type FeePaidBy,
  type NormalizedProviderEvent,
  type PaymentProvider,
  type PayoutPort,
  type ProviderCapabilities,
  type TransactionStatus,
  type WebhookVerification,
} from '../provider.js';
import {
  BachsApiClient,
  LIVE_API_ORIGIN,
  SANDBOX_API_ORIGIN,
  type BachsEnvironment,
} from './client.js';
import {
  BachsApiError,
  BachsProtocolError,
  BachsRequestNotSentError,
  UncertainProviderOutcomeError,
} from './errors.js';
import { decimalToMinor, minorToDecimal } from './money.js';
import { PAYOUT_CONFIGURATION, createBachsPayouts } from './payouts.js';
import { verifyBachsWebhook } from './webhooks.js';

const checkoutCreatedSchema = z.object({
  checkout_id: z.string().min(1),
  checkout_url: z.string().url(),
  status: z.string().min(1),
  expires_at: z.string().nullable().optional(),
});

const checkoutSessionSchema = z.object({
  checkout_id: z.string().min(1),
  checkout_url: z.string().url().optional(),
  status: z.string().min(1),
  amount: z.string(),
  currency: z.string().length(3),
  payment_status: z.string().nullable().optional(),
  charge: z
    .object({
      payment_id: z.string().nullable().optional(),
      id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const paymentSchema = z.object({
  payment_id: z.string().min(1),
  status: z.string().min(1),
  amount: z.string(),
  amount_paid: z.string().nullable().optional(),
  // Any asset code: Bachs reports crypto collections as e.g. USDT_TRC20.
  currency: z.string().min(1).max(32),
  platform_fee: z.string().nullable().optional(),
  fee_paid_by: z.enum(['merchant', 'platform']).nullable().optional(),
  settlement_currency: z.string().min(1).max(32).nullable().optional(),
  fees: z
    .object({
      amount: z.string(),
      currency: z.string().min(1).max(32),
    })
    .nullable()
    .optional(),
  // How it was paid; read on TipMe's own checkouts, where the payer picks card or transfer.
  payment_method_type: z.string().max(64).nullable().optional(),
});

const accountSchema = z.object({
  id: z.string().trim().min(1).max(200),
  country: z.string().nullable().optional(),
  balance_currencies: z.array(z.string()).nullable().optional(),
  is_active: z.boolean().optional(),
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  responsibilities: z
    .object({
      fees: z
        .object({ collector: z.enum(['platform', 'merchant']) })
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  requirements: z
    .object({
      currently_due: z.array(z.string()).optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

const accountLinkSchema = z.object({
  url: z.string().url(),
});

const accountInputSchema = z.object({
  contactEmail: z.email(),
  country: z.string().regex(/^[A-Z]{2}$/),
  displayName: z.string().trim().min(1).max(255).optional(),
  entityType: z.enum(['individual', 'company']),
  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\w.:-]+$/),
});

const urlInputSchema = z.string().url();

export type { BachsEnvironment };

export interface BachsProviderConfig {
  apiKey: string;
  /** Required: the key's prefix must match it, and requests go only to its origin. */
  environment: BachsEnvironment;
  /** Omitted for a read-only adapter (the worker): it then refuses every webhook. */
  webhookSecrets?: readonly string[];
  /**
   * TipMe's own organization at Bachs (BACHS_PLATFORM_ORGANIZATION_ID). Its events with no
   * `account` are TipMe's own (Pro purchases). Unset: every event is read as a connected account's.
   */
  platformOrganizationId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface BachsRecipientAccount {
  accountReference: string;
  active: boolean | null;
  ngnCardCollectionStatus: string | null;
  bankTransferStatus: string | null;
  feeCollector: 'platform' | 'connected_account' | 'unknown';
  requirementsDue: string[];
  /**
   * Whether the account holds its country's currency, which is what Bachs settles it in. Null
   * when TipMe knows no local currency for the country, or Bachs did not say.
   */
  holdsLocalCurrency: boolean | null;
}

/** The currency a recipient is paid in, by Bachs account country. TipMe takes naira only. */
const LOCAL_CURRENCY: Readonly<Record<string, string>> = { NG: 'NGN' };

export interface BachsProvider
  extends
    Omit<PaymentProvider<NormalizedProviderEvent>, keyof PayoutPort>,
    PayoutPort {
  /** The PAYMENT_PROVIDER this adapter is. Rows still record provider 'bachs' (ADR-0004). */
  readonly name: 'bachs-sandbox' | 'bachs-live';
  /** Which Bachs this adapter talks to; recorded on payment accounts. */
  readonly environment: BachsEnvironment;
  createRecipientAccount(input: {
    contactEmail: string;
    country: string;
    displayName?: string;
    entityType: 'individual' | 'company';
    idempotencyKey: string;
  }): Promise<BachsRecipientAccount>;
  /**
   * Business release 2, option B: a company account that only receives (the recipient persona:
   * payouts and transfers, sandbox S1), never takes payments, so no selfie check or review.
   */
  createReceiveOnlyAccount(input: {
    contactEmail: string;
    country: string;
    displayName?: string;
    idempotencyKey: string;
  }): Promise<BachsRecipientAccount>;
  createOnboardingLink(input: {
    accountReference: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<string>;
  getRecipientAccount(accountReference: string): Promise<BachsRecipientAccount>;
  /**
   * Makes the account hold its local currency. A new Bachs account holds only USD, and Bachs
   * converts a naira tip to an account without NGN, leaving its fee bearer unknown.
   */
  holdLocalCurrency(accountReference: string): Promise<BachsRecipientAccount>;
  getCheckoutUrl(providerReference: string): Promise<string>;
}

const capabilities: ProviderCapabilities = {
  hostedCheckout: true,
  connectedAccounts: true,
  platformFees: true,
  payouts: true,
  lookupByOperationReference: false,
  platformCheckout: true,
};

/** TipMe's own checkouts (paid Pro): `platform:<checkout_id>`, never an account id. */
const PLATFORM_PREFIX = 'platform:';
/** TipMe's own off-session charges (auto-renew): `platform-charge:<payment_id>`. */
const PLATFORM_CHARGE_PREFIX = 'platform-charge:';

// https://docs.bachs.io/guides/refunds
const refundCreatedSchema = z.object({
  refund_id: z.string().min(1).max(200),
  status: z.string().min(1),
});
// https://docs.bachs.io/guides/payments/charge-a-saved-card
const customerSchema = z.object({ customer_id: z.string().min(1).max(200) });
const chargeSchema = z.object({
  payment_id: z.string().min(1).max(200),
  status: z.string().min(1),
});
// Errors the saved-card guide lists: nothing could be charged.
const SAVED_CARD_REFUSALS = new Set([
  'NO_SAVED_PAYMENT_METHOD',
  'SAVED_PAYMENT_METHOD_NOT_FOUND',
  'PAYMENT_METHOD_UNUSABLE',
  'PAYMENT_METHOD_NOT_ENABLED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
]);
/** Partner checkouts last 30 minutes (sandbox evidence, 9 Nov 2026); asked for explicitly. */
const PLATFORM_CHECKOUT_MINUTES = 30;

function methodOf(
  value: string | null | undefined,
): 'NGN_CARD' | 'NGN_BANK_TRANSFER' | undefined {
  const method = value?.toUpperCase() ?? '';
  if (method.includes('BANK')) return 'NGN_BANK_TRANSFER';
  if (method.includes('CARD')) return 'NGN_CARD';
  return undefined;
}

function statusValue(value: string): TransactionStatus {
  const status = value.toLowerCase();
  if (status === 'succeeded' || status === 'accepted' || status === 'overpaid')
    return 'succeeded';
  if (status === 'failed' || status === 'canceled' || status === 'cancelled')
    return 'failed';
  return 'pending';
}

function providerAmountToMinor(value: string, currency: string): bigint {
  try {
    return decimalToMinor(value, currency);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      throw new BachsProtocolError(
        'Bachs returned an invalid amount or currency precision',
      );
    throw error;
  }
}

function feePaidBy(
  value: 'merchant' | 'platform' | null | undefined,
): FeePaidBy {
  if (value === 'platform') return 'platform';
  if (value === 'merchant') return 'connected_account';
  return 'unknown';
}

function scopedCheckoutReference(
  accountReference: string,
  checkoutId: string,
): string {
  return `${accountReference}:${checkoutId}`;
}

function providerIdentifier(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > 200 ||
    value.includes(':') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`Invalid Bachs ${label}`);
  }
  return value;
}

function parseScopedCheckoutReference(value: string): {
  /** Null for TipMe's own checkouts: no account header is sent. */
  accountReference: string | null;
  checkoutId: string;
} {
  if (value.startsWith(PLATFORM_PREFIX))
    return {
      accountReference: null,
      checkoutId: providerIdentifier(
        value.slice(PLATFORM_PREFIX.length),
        'checkout reference',
      ),
    };
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1)
    throw new TypeError('Invalid Bachs checkout reference');
  return {
    accountReference: providerIdentifier(
      value.slice(0, separator),
      'account reference',
    ),
    checkoutId: providerIdentifier(
      value.slice(separator + 1),
      'checkout reference',
    ),
  };
}

function bachsHostedUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !(url.hostname === 'bachs.io' || url.hostname.endsWith('.bachs.io'))
  ) {
    throw new BachsProtocolError(
      'Bachs returned a URL outside its HTTPS domain',
    );
  }
  return url.toString();
}

function normalizedAccount(
  account: z.infer<typeof accountSchema>,
): BachsRecipientAccount {
  const capabilities =
    account.capabilities && typeof account.capabilities === 'object'
      ? account.capabilities
      : {};
  const capabilityStatus = (name: string): string | null => {
    const capability = capabilities[name];
    return typeof capability === 'object' &&
      capability !== null &&
      'status' in capability &&
      typeof capability.status === 'string'
      ? capability.status
      : null;
  };
  const collector = account.responsibilities?.fees?.collector;
  const localCurrency = account.country
    ? LOCAL_CURRENCY[account.country]
    : undefined;

  return {
    accountReference: account.id,
    active: account.is_active ?? null,
    ngnCardCollectionStatus: capabilityStatus('ngn_card_collection'),
    bankTransferStatus: capabilityStatus('bank_transfer'),
    feeCollector:
      collector === 'platform'
        ? 'platform'
        : collector === 'merchant'
          ? 'connected_account'
          : 'unknown',
    requirementsDue: account.requirements?.currently_due ?? [],
    holdsLocalCurrency:
      localCurrency && account.balance_currencies
        ? account.balance_currencies.includes(localCurrency)
        : null,
  };
}

const BLOCKED_CAPABILITY = new Set([
  'restricted',
  'inactive',
  'disabled',
  'rejected',
]);

/**
 * Whether TipMe may start checkouts for this account, from Bachs' own account read. Ready needs
 * an active account, active NGN card collection and fees charged to the platform; a recipient
 * who would bear Bachs' fees, or a restricted account, is blocked rather than left onboarding.
 */
export function bachsAccountReadiness(account: BachsRecipientAccount): {
  status: 'ACTIVE' | 'ONBOARDING' | 'RESTRICTED';
  chargesEnabled: boolean;
} {
  if (
    // Inactive with collection already granted: Bachs switched off a set-up account. A new
    // account is inactive too, until its form is finished; that one is still onboarding.
    (account.active === false &&
      account.ngnCardCollectionStatus === 'active') ||
    account.feeCollector === 'connected_account' ||
    BLOCKED_CAPABILITY.has(account.ngnCardCollectionStatus ?? '')
  )
    return { status: 'RESTRICTED', chargesEnabled: false };
  if (
    account.active === true &&
    account.ngnCardCollectionStatus === 'active' &&
    account.feeCollector === 'platform'
  )
    return { status: 'ACTIVE', chargesEnabled: true };
  return { status: 'ONBOARDING', chargesEnabled: false };
}

function validateHttpsOrLocalUrl(value: string): string {
  const url = new URL(urlInputSchema.parse(value));
  if (
    url.username !== '' ||
    url.password !== '' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      ))
  ) {
    throw new TypeError('Return URLs must use HTTPS or a localhost origin');
  }
  return url.toString();
}

export function createBachsProvider(
  config: BachsProviderConfig,
): BachsProvider {
  const webhookSecrets = config.webhookSecrets ?? [];
  if (webhookSecrets.length > 5)
    throw new TypeError('At most five Bachs webhook secrets may be configured');
  if (
    webhookSecrets.some((secret) => secret.length < 16 || /[\r\n]/.test(secret))
  ) {
    throw new TypeError('Invalid Bachs webhook secret');
  }

  const client = new BachsApiClient(config);

  async function getAccount(accountReference: string) {
    providerIdentifier(accountReference, 'account reference');
    const account = await client.request({
      method: 'GET',
      path: `/v1/accounts/${encodeURIComponent(accountReference)}`,
      schema: accountSchema,
    });
    return normalizedAccount(account);
  }

  async function holdLocalCurrency(accountReference: string) {
    providerIdentifier(accountReference, 'account reference');
    const path = `/v1/accounts/${encodeURIComponent(accountReference)}`;
    const account = await client.request({
      method: 'GET',
      path,
      schema: accountSchema,
    });
    const localCurrency = account.country
      ? LOCAL_CURRENCY[account.country]
      : undefined;
    if (!localCurrency || account.balance_currencies?.includes(localCurrency))
      return normalizedAccount(account);
    const updated = await client.request({
      method: 'POST',
      path,
      // Adds the currency and leaves the others held: USD always stays.
      body: { balance_currencies: { [localCurrency]: true } },
      operationReference: accountReference,
      schema: accountSchema,
    });
    return normalizedAccount(updated);
  }

  /** A payment on TipMe's own account, read directly (an off-session charge has no checkout). */
  async function readPlatformPayment(paymentId: string) {
    const payment = await client.request({
      method: 'GET',
      path: `/v1/payments/${encodeURIComponent(paymentId)}`,
      schema: paymentSchema,
    });
    const status = statusValue(payment.status);
    if (payment.currency !== 'NGN')
      return {
        status,
        amountMinor: 0n,
        currency: payment.currency,
        feeMinor: 0n,
        feePaidBy: 'platform' as const,
        chargeReference: payment.payment_id,
      };
    const amountMinor = providerAmountToMinor(
      payment.amount_paid ?? payment.amount,
      payment.currency,
    );
    const fee = payment.fees ?? null;
    if (fee && fee.currency !== payment.currency)
      throw new BachsProtocolError(
        'Bachs processing fee currency differs from payment currency',
      );
    const feeMinor = fee ? providerAmountToMinor(fee.amount, fee.currency) : 0n;
    const waitingForFee = status === 'succeeded' && fee === null;
    return {
      status: waitingForFee ? ('pending' as const) : status,
      amountMinor,
      currency: payment.currency,
      feeMinor,
      feePaidBy: 'platform' as const,
      ...(waitingForFee ? { collected: true as const } : {}),
      method: 'NGN_CARD' as const,
      chargeReference: payment.payment_id,
    };
  }

  return {
    name: client.environment === 'live' ? 'bachs-live' : 'bachs-sandbox',
    environment: client.environment,
    capabilities,

    async initializePayment(input) {
      // Checked before anything is sent: a refusal here means Bachs never saw the request.
      let idempotencyKey: string;
      let successUrl: string;
      let cancelUrl: string;
      try {
        if (
          !input.recipientAccountReference ||
          input.tipmeShareMinor === undefined ||
          !input.successUrl ||
          !input.cancelUrl
        ) {
          throw new TypeError(
            'Bachs checkout requires an account, complete TipMe share, success URL, and cancel URL',
          );
        }
        providerIdentifier(
          input.recipientAccountReference,
          'account reference',
        );
        if (input.amountMinor <= 0n)
          throw new RangeError('Checkout amount must be positive');
        if (
          input.tipmeShareMinor < 0n ||
          input.tipmeShareMinor >= input.amountMinor
        ) {
          throw new RangeError(
            'TipMe share must be non-negative and less than the tip',
          );
        }

        idempotencyKey =
          input.idempotencyKey ?? `tipme-checkout-${input.attemptId}`;
        if (!/^[\w.:-]{1,255}$/.test(idempotencyKey))
          throw new TypeError('Invalid Bachs idempotency key');

        successUrl = validateHttpsOrLocalUrl(input.successUrl);
        cancelUrl = validateHttpsOrLocalUrl(input.cancelUrl);
      } catch (error) {
        throw new BachsRequestNotSentError(
          error instanceof Error ? error.message : 'Invalid Bachs checkout',
          { cause: error },
        );
      }
      const body: Record<string, unknown> = {
        pricing: {
          amount: minorToDecimal(input.amountMinor, input.currency),
          currency: input.currency,
        },
        reference: input.attemptId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_creation: 'if_required',
        // TipMe quotes and books naira only: Bachs must not offer crypto or other currencies.
        payment_method_types: ['NGN_CARD', 'NGN_BANK_TRANSFER'],
      };
      if (input.tipmeShareMinor > 0n) {
        body['platform_fee'] = minorToDecimal(
          input.tipmeShareMinor,
          input.currency,
        );
      }

      const checkout = await client.request({
        method: 'POST',
        path: '/v1/checkout-sessions',
        accountReference: input.recipientAccountReference,
        idempotencyKey,
        operationReference: input.attemptId,
        body,
        schema: checkoutCreatedSchema,
      });
      if (checkout.status.toLowerCase() !== 'open') {
        throw new UncertainProviderOutcomeError(
          input.attemptId,
          'Bachs created a checkout in an unexpected state',
          { cause: 'unexpected_state' },
        );
      }

      let checkoutUrl: string;
      try {
        checkoutUrl = bachsHostedUrl(checkout.checkout_url);
      } catch (error) {
        if (error instanceof BachsProtocolError) {
          throw new UncertainProviderOutcomeError(
            input.attemptId,
            'Bachs created a checkout but returned an unsafe URL',
            { cause: 'unsafe_url' },
          );
        }
        throw error;
      }

      return {
        providerReference: scopedCheckoutReference(
          input.recipientAccountReference,
          checkout.checkout_id,
        ),
        checkoutUrl,
      };
    },

    async initializePlatformCheckout(input) {
      // Checked before anything is sent: a refusal here means Bachs never saw the request.
      let successUrl: string;
      let cancelUrl: string;
      try {
        if (input.currency !== 'NGN')
          throw new TypeError('TipMe sells Pro in naira only');
        if (input.amountMinor <= 0n)
          throw new RangeError('Checkout amount must be positive');
        providerIdentifier(input.purchaseId, 'purchase reference');
        if (!/^[\w.:-]{1,255}$/.test(input.idempotencyKey))
          throw new TypeError('Invalid Bachs idempotency key');
        successUrl = validateHttpsOrLocalUrl(input.successUrl);
        cancelUrl = validateHttpsOrLocalUrl(input.cancelUrl);
      } catch (error) {
        throw new BachsRequestNotSentError(
          error instanceof Error ? error.message : 'Invalid Bachs checkout',
          { cause: error },
        );
      }
      let checkout: z.infer<typeof checkoutCreatedSchema>;
      try {
        checkout = await client.request({
          method: 'POST',
          path: '/v1/checkout-sessions',
          // No X-Account-Id: the checkout is on TipMe's own account, and no platform fee.
          idempotencyKey: input.idempotencyKey,
          operationReference: input.purchaseId,
          body: {
            pricing: {
              amount: minorToDecimal(input.amountMinor, input.currency),
              currency: input.currency,
            },
            reference: input.purchaseId,
            success_url: successUrl,
            cancel_url: cancelUrl,
            customer_creation: 'if_required',
            payment_method_types: ['NGN_CARD', 'NGN_BANK_TRANSFER'],
            customer_bears_fee: false,
            expires_in_minutes: PLATFORM_CHECKOUT_MINUTES,
            // Auto-renew opt-in: the card is saved on this customer as they pay.
            ...(input.saveCard
              ? {
                  customer: {
                    customer_id: providerIdentifier(
                      input.saveCard.customerReference,
                      'customer reference',
                    ),
                  },
                  save_payment_method: true,
                }
              : {}),
          },
          schema: checkoutCreatedSchema,
        });
      } catch (error) {
        // TipMe's own account can't take payments here (live needs it verified): definite.
        if (
          error instanceof BachsApiError &&
          error.providerCode === 'ACCOUNT_NOT_ACTIVATED'
        )
          throw new PlatformCheckoutUnavailableError(error.providerCode);
        throw error;
      }
      if (checkout.status.toLowerCase() !== 'open')
        throw new UncertainProviderOutcomeError(
          input.purchaseId,
          'Bachs created a checkout in an unexpected state',
          { cause: 'unexpected_state' },
        );
      let checkoutUrl: string;
      try {
        checkoutUrl = bachsHostedUrl(checkout.checkout_url);
      } catch (error) {
        if (error instanceof BachsProtocolError)
          throw new UncertainProviderOutcomeError(
            input.purchaseId,
            'Bachs created a checkout but returned an unsafe URL',
            { cause: 'unsafe_url' },
          );
        throw error;
      }
      const stated = checkout.expires_at ? new Date(checkout.expires_at) : null;
      return {
        providerReference: `${PLATFORM_PREFIX}${providerIdentifier(checkout.checkout_id, 'checkout reference')}`,
        checkoutUrl,
        expiresAt:
          stated && !Number.isNaN(stated.getTime())
            ? stated
            : new Date(Date.now() + PLATFORM_CHECKOUT_MINUTES * 60_000),
      };
    },

    async findPayment(attemptId) {
      throw new UncertainProviderOutcomeError(
        attemptId,
        'Bachs does not support checkout lookup by TipMe operation reference',
      );
    },

    async getCheckoutUrl(providerReference) {
      const scopedReference = parseScopedCheckoutReference(providerReference);
      const checkout = await client.request({
        method: 'GET',
        path: `/v1/checkout-sessions/${encodeURIComponent(scopedReference.checkoutId)}`,
        ...(scopedReference.accountReference
          ? { accountReference: scopedReference.accountReference }
          : {}),
        schema: checkoutSessionSchema,
      });
      if (!checkout.checkout_url)
        throw new BachsProtocolError(
          'Bachs did not return the hosted checkout URL',
        );
      return bachsHostedUrl(checkout.checkout_url);
    },

    // POST /v1/refunds on TipMe's own account. The same idempotency_key on the same payment returns
    // the existing refund for 24 hours; a 409 or 5xx may mean one exists: uncertain.
    async refundPlatformCharge(input) {
      let body: Record<string, unknown>;
      try {
        if (input.amountMinor <= 0n)
          throw new RangeError('Refund amount must be positive');
        if (!/^[\w.:-]{1,128}$/.test(input.reference))
          throw new TypeError('Invalid refund reference');
        if (!/^[\w.:-]{1,255}$/.test(input.idempotencyKey))
          throw new TypeError('Invalid idempotency key');
        body = {
          charge_id: providerIdentifier(input.chargeReference, 'charge'),
          amount: minorToDecimal(input.amountMinor, 'NGN'),
          reference: input.reference,
          reason: 'Customer requested cancellation',
          idempotency_key: input.idempotencyKey,
        };
      } catch (error) {
        throw new BachsRequestNotSentError(
          error instanceof Error ? error.message : 'Invalid refund',
          { cause: error },
        );
      }
      let refund: z.infer<typeof refundCreatedSchema>;
      try {
        refund = await client.request({
          method: 'POST',
          path: '/v1/refunds',
          idempotencyKey: input.idempotencyKey,
          operationReference: input.reference,
          body,
          schema: refundCreatedSchema,
        });
      } catch (error) {
        // The guide's 400s (not refundable, no balance, too much) create nothing.
        if (error instanceof BachsApiError && error.statusCode === 400)
          throw new ProRefundRefusedError(error.providerCode);
        if (error instanceof BachsApiError)
          throw new UncertainProviderOutcomeError(
            input.reference,
            `the payment provider returned HTTP ${error.statusCode}`,
            { cause: 'http_error', httpStatus: error.statusCode },
          );
        throw error;
      }
      const status = refund.status.toLowerCase();
      return {
        refundReference: refund.refund_id,
        status:
          status === 'success' || status === 'paid' || status === 'succeeded'
            ? 'paid'
            : status === 'failed'
              ? 'failed'
              : 'processing',
      };
    },

    // POST /v1/customers on TipMe's own account.
    async createPlatformCustomer(input) {
      const customer = await client.request({
        method: 'POST',
        path: '/v1/customers',
        idempotencyKey: input.idempotencyKey,
        operationReference: input.idempotencyKey,
        body: { email: input.email, name: input.name },
        schema: customerSchema,
      });
      return {
        customerReference: providerIdentifier(
          customer.customer_id,
          'customer reference',
        ),
      };
    },

    // POST /v1/charges: off-session, once per Idempotency-Key. A refused card is a 201 `failed`.
    async chargeSavedCard(input) {
      let body: Record<string, unknown>;
      try {
        if (input.currency !== 'NGN')
          throw new TypeError('TipMe sells Pro in naira only');
        if (!/^[\w.:-]{1,255}$/.test(input.idempotencyKey))
          throw new TypeError('Invalid idempotency key');
        body = {
          customer: providerIdentifier(input.customerReference, 'customer'),
          payment_method: providerIdentifier(
            input.paymentMethodReference,
            'payment method',
          ),
          amount: minorToDecimal(input.amountMinor, 'NGN'),
          currency: 'NGN',
          description: 'TipMe Pro',
          reference: providerIdentifier(input.reference, 'reference'),
        };
      } catch (error) {
        throw new BachsRequestNotSentError(
          error instanceof Error ? error.message : 'Invalid charge',
          { cause: error },
        );
      }
      let charge: z.infer<typeof chargeSchema>;
      try {
        charge = await client.request({
          method: 'POST',
          path: '/v1/charges',
          idempotencyKey: input.idempotencyKey,
          operationReference: input.reference,
          body,
          schema: chargeSchema,
        });
      } catch (error) {
        if (
          error instanceof BachsApiError &&
          error.statusCode < 500 &&
          error.providerCode &&
          SAVED_CARD_REFUSALS.has(error.providerCode)
        )
          throw new SavedCardRefusedError(error.providerCode);
        if (error instanceof BachsApiError)
          throw new UncertainProviderOutcomeError(
            input.reference,
            `the payment provider returned HTTP ${error.statusCode}`,
            { cause: 'http_error', httpStatus: error.statusCode },
          );
        throw error;
      }
      const status = statusValue(charge.status);
      return {
        providerReference: `${PLATFORM_CHARGE_PREFIX}${providerIdentifier(charge.payment_id, 'charge reference')}`,
        // `processing` is not success: only the read-back says it was paid.
        status: status === 'failed' ? 'failed' : 'pending',
      };
    },

    async verifyTransaction(providerReference, expectation) {
      if (providerReference.startsWith(PLATFORM_CHARGE_PREFIX))
        return readPlatformPayment(
          providerIdentifier(
            providerReference.slice(PLATFORM_CHARGE_PREFIX.length),
            'charge reference',
          ),
        );
      const scopedReference = parseScopedCheckoutReference(providerReference);

      const checkout = await client.request({
        method: 'GET',
        path: `/v1/checkout-sessions/${encodeURIComponent(scopedReference.checkoutId)}`,
        ...(scopedReference.accountReference
          ? { accountReference: scopedReference.accountReference }
          : {}),
        schema: checkoutSessionSchema,
      });
      const checkoutStatus = checkout.status.toLowerCase();
      if (checkoutStatus === 'expired' || checkoutStatus === 'cancelled')
        return {
          status: 'failed',
          amountMinor: providerAmountToMinor(
            checkout.amount,
            checkout.currency,
          ),
          currency: checkout.currency,
          feeMinor: 0n,
          feePaidBy: 'unknown',
        };
      if (
        checkoutStatus !== 'completed' ||
        !['paid', 'succeeded'].includes(
          checkout.payment_status?.toLowerCase() ?? '',
        )
      ) {
        return {
          status: 'pending',
          amountMinor: providerAmountToMinor(
            checkout.amount,
            checkout.currency,
          ),
          currency: checkout.currency,
          feeMinor: 0n,
          feePaidBy: 'unknown',
        };
      }

      const paymentReference =
        checkout.charge?.payment_id ?? checkout.charge?.id;
      if (!paymentReference) {
        // Completed and paid, but the charge is not linked yet: money was taken.
        return {
          status: 'pending',
          amountMinor: providerAmountToMinor(
            checkout.amount,
            checkout.currency,
          ),
          currency: checkout.currency,
          feeMinor: 0n,
          feePaidBy: 'unknown',
          collected: true,
        };
      }

      const payment = await client.request({
        method: 'GET',
        path: `/v1/payments/${encodeURIComponent(paymentReference)}`,
        ...(scopedReference.accountReference
          ? { accountReference: scopedReference.accountReference }
          : {}),
        schema: paymentSchema,
      });
      if (payment.currency !== checkout.currency) {
        // Taken in another currency (e.g. crypto) although the quote is naira. Report the
        // definite outcome with its real currency: it can never match the quote, so TipMe holds
        // it as a mismatch and raises a money issue instead of booking it.
        const outcome = statusValue(payment.status);
        return {
          status: outcome,
          amountMinor: 0n,
          currency: payment.currency,
          feeMinor: 0n,
          feePaidBy: feePaidBy(payment.fee_paid_by),
        };
      }
      const amount = payment.amount_paid ?? payment.amount;
      const amountMinor = providerAmountToMinor(amount, payment.currency);
      const providerStatus = statusValue(payment.status);
      const fee = payment.fees ?? null;
      const feeMinor =
        fee && fee.currency === payment.currency
          ? providerAmountToMinor(fee.amount, fee.currency)
          : 0n;
      if (fee && fee.currency !== payment.currency)
        throw new BachsProtocolError(
          'Bachs processing fee currency differs from payment currency',
        );

      // TipMe's own checkout (paid Pro): TipMe is the merchant and bears the fee, with no platform
      // fee to check. Its fee is the read-back's; with none yet, the money is held as collected.
      if (scopedReference.accountReference === null) {
        const method = methodOf(payment.payment_method_type);
        const waitingForFee = providerStatus === 'succeeded' && fee === null;
        return {
          status: waitingForFee ? 'pending' : providerStatus,
          amountMinor,
          currency: payment.currency,
          feeMinor,
          feePaidBy: 'platform',
          ...(waitingForFee ? { collected: true as const } : {}),
          ...(method ? { method } : {}),
          chargeReference: payment.payment_id,
        };
      }

      const platformFeeMinor =
        payment.platform_fee === null || payment.platform_fee === undefined
          ? 0n
          : providerAmountToMinor(payment.platform_fee, payment.currency);
      const actualFeeBearer = feePaidBy(payment.fee_paid_by);
      const verifiedPlatformFee =
        expectation !== undefined &&
        platformFeeMinor === expectation.platformFeeMinor;
      const verifiedProcessingFee =
        actualFeeBearer === 'platform' && fee !== null;
      // Bachs took the money, but the fee evidence that lets TipMe book it is not final (or
      // does not match): hold it pending, and say it was collected so it is never expired.
      const unverifiedSuccess =
        providerStatus === 'succeeded' &&
        (!verifiedPlatformFee || !verifiedProcessingFee);
      // Bachs converted it to a currency the account holds; it then never says who paid the fee.
      const settledElsewhere =
        payment.settlement_currency &&
        payment.settlement_currency !== payment.currency
          ? payment.settlement_currency
          : undefined;

      return {
        status: unverifiedSuccess ? 'pending' : providerStatus,
        amountMinor,
        currency: payment.currency,
        feeMinor,
        feePaidBy: actualFeeBearer,
        platformFeeMinor,
        ...(unverifiedSuccess ? { collected: true as const } : {}),
        ...(settledElsewhere ? { settlementCurrency: settledElsewhere } : {}),
      };
    },

    verifyWebhook(
      rawBody,
      headers,
      now,
    ): WebhookVerification<NormalizedProviderEvent> {
      return verifyBachsWebhook(
        rawBody,
        headers,
        webhookSecrets,
        now,
        config.platformOrganizationId,
      );
    },

    async createRecipientAccount(input) {
      const validInput = accountInputSchema.parse(input);
      const account = await client.request({
        method: 'POST',
        path: '/v1/accounts',
        idempotencyKey: validInput.idempotencyKey,
        operationReference: validInput.idempotencyKey,
        body: {
          contact_email: validInput.contactEmail,
          country: validInput.country,
          display_name: validInput.displayName,
          entity_type: validInput.entityType,
          configuration: {
            merchant: {
              capabilities: {
                ngn_card_collection: { requested: true },
                bank_transfer: { requested: true },
              },
            },
            ...PAYOUT_CONFIGURATION,
          },
          responsibilities: {
            fees: { collector: 'platform' },
          },
        },
        schema: accountSchema,
      });
      return normalizedAccount(account);
    },

    async createReceiveOnlyAccount(input) {
      const validInput = accountInputSchema.parse({
        ...input,
        entityType: 'company',
      });
      const account = await client.request({
        method: 'POST',
        path: '/v1/accounts',
        idempotencyKey: validInput.idempotencyKey,
        operationReference: validInput.idempotencyKey,
        body: {
          contact_email: validInput.contactEmail,
          country: validInput.country,
          display_name: validInput.displayName,
          entity_type: 'company',
          configuration: { ...PAYOUT_CONFIGURATION },
          responsibilities: { fees: { collector: 'platform' } },
        },
        schema: accountSchema,
      });
      return normalizedAccount(account);
    },

    async createOnboardingLink(input) {
      const accountReference = input.accountReference;
      providerIdentifier(accountReference, 'account reference');
      const refreshUrl = validateHttpsOrLocalUrl(input.refreshUrl);
      const returnUrl = validateHttpsOrLocalUrl(input.returnUrl);
      const result = await client.request({
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(accountReference)}/account-links`,
        body: {
          type: 'onboarding',
          refresh_url: refreshUrl,
          return_url: returnUrl,
        },
        operationReference: accountReference,
        schema: accountLinkSchema,
      });
      return bachsHostedUrl(result.url);
    },

    getRecipientAccount: getAccount,
    holdLocalCurrency,

    ...createBachsPayouts(client, config.apiKey),
  };
}

export { LIVE_API_ORIGIN, SANDBOX_API_ORIGIN };
