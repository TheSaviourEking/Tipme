import { randomUUID } from 'node:crypto';
import { mockWebhookSchema, type MockWebhook } from '@tipme/contracts';
import type { Redis } from 'ioredis';
import { UncertainProviderOutcomeError } from '../bachs/errors.js';
import {
  PayoutRejectedError,
  PlatformRefusalError,
  ProRefundRefusedError,
  SavedCardRefusedError,
} from '../provider.js';
import type {
  PaymentProvider,
  PayoutPort,
  TransactionStatus,
  WebhookVerification,
} from '../provider.js';
import { SIGNATURE_HEADER, verifySignature } from '../signing.js';
import { attemptKey, paymentKey, payoutIdKey, payoutKey } from './keys.js';
import type { Scenario } from './scenario.js';

/** Same rounding as CURRENT_FEE_POLICY's estimated processing fee (150 bps, half up). */
export const mockProviderFee = (amountMinor: bigint): bigint =>
  (amountMinor * 150n + 5000n) / 10000n;

/** The status the pretend provider ends up holding once a scenario has played out. */
function finalStatus(scenario: Scenario | undefined): TransactionStatus {
  if (scenario === 'decline') return 'failed';
  if (scenario === 'forged') return 'pending';
  return 'succeeded';
}

const PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'pending',
]);
const PAYOUT_STATUSES: ReadonlySet<string> = new Set([
  'paid',
  'failed',
  'pending',
  'review',
]);

/** Enough that a pretend balance never limits a withdrawal: the ledger decides. */
const PRETEND_BALANCE_MINOR = 100_000_000_000n;

export interface MockProvider
  extends
    Omit<PaymentProvider<MockWebhook>, keyof PayoutPort>,
    Omit<PayoutPort, 'initiatePayout'> {
  initializePayment(input: {
    attemptId: string;
    amountMinor: bigint;
    currency: string;
    scenario?: Scenario;
  }): Promise<{ providerReference: string }>;
  initiatePayout(input: {
    payoutId: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    /** Bachs needs these; the pretend payout has no real account or bank to reach. */
    accountRef?: string;
    destinationRef?: string;
    scenario?: Scenario;
  }): ReturnType<PayoutPort['initiatePayout']>;
  markStatus(reference: string, status: TransactionStatus): Promise<void>;
  /** Paid Pro: how the pretend payer paid a `mock_pro_` checkout (card unless set). */
  markMethod(
    reference: string,
    method: 'NGN_CARD' | 'NGN_BANK_TRANSFER',
  ): Promise<void>;
  /** Paid Pro: what the pretend partner says it took, for short and over payments. */
  markAmount(reference: string, amountMinor: bigint): Promise<void>;
  /**
   * Paid Pro from the balance and saved-card renewals: how the pretend partner answers the next
   * collect from this account, or charge of this customer (paid unless set; used once).
   */
  markNextMove(
    who: string,
    outcome: 'refused' | 'uncertain' | 'declined',
  ): Promise<void>;
  /**
   * Sets the scenario the pretend checkout page chose. Only the first choice counts (false after
   * that, or for an unknown reference), so an outcome can never be changed once played.
   */
  chooseScenario(reference: string, scenario: Scenario): Promise<boolean>;
  /** Moves the pretend payment to the status its scenario ends in. */
  settle(reference: string): Promise<void>;
  /** Moves the pretend payout to the status its scenario ends in. */
  settlePayout(reference: string): Promise<void>;
}

/**
 * A local stand-in for a real provider. Never usable in production (refused at startup).
 * Without a secret (e.g. in the worker, which never receives webhooks) every webhook is rejected.
 */
export function createMockProvider(options: {
  redis: Redis;
  secret?: string;
  prefix?: string;
}): MockProvider {
  const { redis } = options;
  const secret = options.secret ?? '';
  const prefix = options.prefix ?? 'default';

  const readPayout: PayoutPort['fetchPayoutStatus'] = async (
    providerReference,
  ) => {
    const status = await redis.hget(
      payoutKey(prefix, providerReference),
      'status',
    );
    if (status === null) return { status: 'not_found' };
    if (status === 'failed') return { status, failureReason: 'other' };
    return {
      status: PAYOUT_STATUSES.has(status)
        ? (status as 'paid' | 'pending' | 'review')
        : 'pending',
    };
  };

  return {
    name: 'mock',
    capabilities: {
      hostedCheckout: true,
      connectedAccounts: false,
      platformFees: false,
      payouts: true,
      lookupByOperationReference: true,
      platformCheckout: true,
    },

    /**
     * Paid Pro (ADR-0015): a pretend checkout on TipMe's own account, `mock_pro_<uuid>`, one per
     * purchase however often it is retried. Paid on /mock-checkout like a tip.
     */
    async initializePlatformCheckout({
      purchaseId,
      amountMinor,
      currency,
      saveCard,
    }) {
      const reference = `mock_pro_${randomUUID()}`;
      const claimKey = attemptKey(prefix, `pro:${purchaseId}`);
      const claimed = await redis.set(claimKey, reference, 'NX');
      const providerReference =
        claimed === 'OK'
          ? reference
          : ((await redis.get(claimKey)) ?? reference);
      if (claimed === 'OK')
        await redis.hset(paymentKey(prefix, reference), {
          purchaseId,
          amountMinor: amountMinor.toString(),
          currency,
          feeMinor: mockProviderFee(amountMinor).toString(),
          scenario: 'succeed',
          status: 'pending',
          method: 'NGN_CARD',
          ...(saveCard ? { customer: saveCard.customerReference } : {}),
        });
      return {
        providerReference,
        checkoutUrl: `/mock-checkout/${providerReference}`,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    },

    async initializePayment({ attemptId, amountMinor, currency, scenario }) {
      // Like a real provider's unique merchant reference: one payment per attempt, however
      // often the start is retried.
      const reference = `mock_pay_${randomUUID()}`;
      const claimed = await redis.set(
        attemptKey(prefix, attemptId),
        reference,
        'NX',
      );
      if (claimed !== 'OK') {
        const existing = await redis.get(attemptKey(prefix, attemptId));
        if (existing) return { providerReference: existing };
      }
      await redis.hset(paymentKey(prefix, reference), {
        attemptId,
        amountMinor: amountMinor.toString(),
        currency,
        feeMinor: mockProviderFee(amountMinor).toString(),
        scenario: scenario ?? 'succeed',
        // A no-reply payment is captured, but the provider never says so.
        status: scenario === 'no-reply' ? 'succeeded' : 'pending',
      });
      return { providerReference: reference };
    },

    async findPayment(attemptId) {
      const reference = await redis.get(attemptKey(prefix, attemptId));
      return reference ? { providerReference: reference } : null;
    },

    async verifyTransaction(providerReference) {
      const stored = await redis.hgetall(paymentKey(prefix, providerReference));
      if (!stored['status'])
        return {
          status: 'not_found',
          amountMinor: 0n,
          currency: 'XXX',
          feeMinor: 0n,
        };
      const amount = BigInt(stored['amountMinor'] ?? '0');
      // An unrecognised stored status is never acted on: report it as still pending.
      const status = PAYMENT_STATUSES.has(stored['status'])
        ? (stored['status'] as TransactionStatus)
        : 'pending';
      return {
        status,
        // The wrong-amount scenario's provider really did capture a different amount.
        amountMinor:
          stored['scenario'] === 'wrong-amount' ? amount - 1n : amount,
        currency: stored['currency'] ?? 'XXX',
        feeMinor: BigInt(stored['feeMinor'] ?? '0'),
        ...(stored['method'] === 'NGN_CARD' ||
        stored['method'] === 'NGN_BANK_TRANSFER'
          ? { method: stored['method'], feePaidBy: 'platform' as const }
          : {}),
        // TipMe's own (Pro) payments name their pretend charge, which a refund names.
        ...(stored['purchaseId'] || stored['charge']
          ? { chargeReference: `mock_ch_${providerReference}` }
          : {}),
        // A card saved while paying (the real partner says so by webhook instead).
        ...(stored['customer'] &&
        status === 'succeeded' &&
        stored['method'] === 'NGN_CARD'
          ? {
              savedMethod: {
                customerReference: stored['customer'],
                paymentMethodReference: `mock_pm_${stored['customer']}`,
              },
            }
          : {}),
      };
    },

    verifyWebhook(
      rawBody,
      headers,
      now = new Date(),
    ): WebhookVerification<MockWebhook> {
      if (secret.length < 32) return { ok: false, reason: 'bad_signature' };
      const header = headers[SIGNATURE_HEADER];
      const result = verifySignature(
        rawBody,
        Array.isArray(header) ? header[0] : header,
        secret,
        now,
      );
      if (result !== 'ok') return { ok: false, reason: result };
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      const event = mockWebhookSchema.safeParse(parsed);
      return event.success
        ? { ok: true, event: event.data }
        : { ok: false, reason: 'malformed' };
    },

    async initiatePayout({
      payoutId,
      idempotencyKey,
      amountMinor,
      currency,
      scenario,
    }) {
      const reference = `mock_out_${idempotencyKey}`;
      const chosen = scenario ?? 'payout-paid';
      const status = chosen === 'payout-review' ? 'review' : 'pending';
      const result = await redis.eval(
        `if redis.call('EXISTS', KEYS[1]) == 0 then
           redis.call('HSET', KEYS[1], unpack(ARGV))
           return 0
         end
         for i = 1, #ARGV, 2 do
           if ARGV[i] ~= 'scenario' and ARGV[i] ~= 'status'
             and redis.call('HGET', KEYS[1], ARGV[i]) ~= ARGV[i + 1] then
             return -1
           end
         end
         return 1`,
        1,
        payoutKey(prefix, reference),
        'payoutId',
        payoutId,
        'amountMinor',
        amountMinor.toString(),
        'currency',
        currency,
        'scenario',
        chosen,
        'status',
        status,
      );
      if (result === -1)
        throw new Error(
          'Mock payout idempotency key was reused with different payout details',
        );
      await redis.set(payoutIdKey(prefix, payoutId), reference, 'NX');
      // The payout now exists, but its answer is lost; the same key finds it later.
      if (result === 0 && chosen === 'payout-timeout')
        throw new UncertainProviderOutcomeError(
          idempotencyKey,
          'the request may have reached the payment provider but its response was not received',
          { cause: 'no_response' },
        );
      return { providerReference: reference, status };
    },

    fetchPayoutStatus: readPayout,

    async findPayoutByReference(_accountRef, payoutId) {
      const providerReference = await redis.get(payoutIdKey(prefix, payoutId));
      if (!providerReference) return null;
      const { status, failureReason } = await readPayout(providerReference);
      // The id always points at a stored payout, unless the pretend ledger was wiped under it.
      if (status === 'not_found') return null;
      return {
        providerReference,
        status,
        ...(failureReason ? { failureReason } : {}),
      };
    },

    async settlePayout(reference) {
      const scenario = await redis.hget(
        payoutKey(prefix, reference),
        'scenario',
      );
      // A payout in review has no outcome to play out.
      if (scenario && scenario !== 'payout-review') {
        await redis.hset(payoutKey(prefix, reference), {
          status: scenario === 'payout-failed' ? 'failed' : 'paid',
        });
      }
    },

    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },

    async listBanks() {
      return [
        { code: '058', name: 'Pretend Guaranty Bank' },
        { code: '101', name: 'Pretend Providus Bank' },
      ];
    },

    async resolveBankAccount({ accountNumber }) {
      return accountNumber.endsWith('0000')
        ? null
        : { accountName: 'PRETEND ACCOUNT HOLDER' };
    },

    async addPayoutDestination(accountRef, { accountNumber, bankCode }) {
      return {
        destinationRef: `mock_dest_${accountRef}_${bankCode}_${accountNumber.slice(-4)}`,
        usable: true,
        status: 'usable',
      };
    },

    async payoutDestinationStatus() {
      return 'usable';
    },

    async payoutBalance() {
      return { availableMinor: PRETEND_BALANCE_MINOR };
    },

    async platformBalance() {
      return { availableMinor: PRETEND_BALANCE_MINOR };
    },

    async quotePayoutFee() {
      return { feeMinor: 5000n, exact: false };
    },

    async collectToPlatform({ accountRef, amountMinor, idempotencyKey }) {
      const next = await redis.getdel(
        `mockprovider:${prefix}:next-move:${accountRef}`,
      );
      if (next === 'refused')
        throw new PayoutRejectedError('other', 'INSUFFICIENT_BALANCE');
      const transferRef = `mock_collect_${idempotencyKey}`;
      await redis.hset(`mockprovider:${prefix}:collect:${idempotencyKey}`, {
        transferRef,
        amountMinor: amountMinor.toString(),
      });
      // The transfer exists, but its answer is lost; the read-back finds it.
      if (next === 'uncertain')
        throw new UncertainProviderOutcomeError(
          idempotencyKey,
          'the request may have reached the payment provider but its response was not received',
          { cause: 'no_response' },
        );
      return { transferRef, status: 'paid' };
    },

    // Option B's second leg: TipMe's balance to an account. Kept beside the collects, so one
    // read-back finds either by its key.
    async transferToAccount({ accountRef, amountMinor, idempotencyKey }) {
      const next = await redis.getdel(
        `mockprovider:${prefix}:next-move:${accountRef}`,
      );
      if (next === 'refused')
        throw new PlatformRefusalError('reserve_empty', 'INSUFFICIENT_BALANCE');
      const transferRef = `mock_transfer_${idempotencyKey}`;
      await redis.hset(`mockprovider:${prefix}:collect:${idempotencyKey}`, {
        transferRef,
        amountMinor: amountMinor.toString(),
      });
      if (next === 'uncertain')
        throw new UncertainProviderOutcomeError(
          idempotencyKey,
          'the request may have reached the payment provider but its response was not received',
          { cause: 'no_response' },
        );
      return { transferRef, status: 'paid' };
    },

    async findPlatformCollection(_accountRef, idempotencyKey) {
      const stored = await redis.hgetall(
        `mockprovider:${prefix}:collect:${idempotencyKey}`,
      );
      if (!stored['transferRef']) return null;
      return {
        transferRef: stored['transferRef'],
        status: 'paid',
        amountMinor: BigInt(stored['amountMinor'] ?? '0'),
        currency: 'NGN',
      };
    },

    async refundPlatformCharge({ chargeReference, reference }) {
      const claimed = await redis.set(
        `mockprovider:${prefix}:refund:${chargeReference}`,
        reference,
        'NX',
      );
      if (claimed !== 'OK') {
        const existing = await redis.get(
          `mockprovider:${prefix}:refund:${chargeReference}`,
        );
        if (existing !== reference)
          throw new ProRefundRefusedError('BAD_REQUEST');
      }
      return { refundReference: `mock_rf_${reference}`, status: 'processing' };
    },

    async createPlatformCustomer({ idempotencyKey }) {
      return { customerReference: `mock_cust_${idempotencyKey}` };
    },

    async chargeSavedCard({
      customerReference,
      amountMinor,
      currency,
      reference,
      idempotencyKey,
    }) {
      const next = await redis.getdel(
        `mockprovider:${prefix}:next-move:${customerReference}`,
      );
      if (next === 'refused')
        throw new SavedCardRefusedError('PAYMENT_METHOD_UNUSABLE');
      const providerReference = `mock_charge_${idempotencyKey}`;
      await redis.hsetnx(
        paymentKey(prefix, providerReference),
        'status',
        next === 'declined' ? 'failed' : 'succeeded',
      );
      await redis.hset(paymentKey(prefix, providerReference), {
        charge: reference,
        amountMinor: amountMinor.toString(),
        currency,
        feeMinor: mockProviderFee(amountMinor).toString(),
        scenario: 'succeed',
        method: 'NGN_CARD',
      });
      if (next === 'uncertain')
        throw new UncertainProviderOutcomeError(
          idempotencyKey,
          'the request may have reached the payment provider but its response was not received',
          { cause: 'no_response' },
        );
      return {
        providerReference,
        status: next === 'declined' ? 'failed' : 'pending',
      };
    },

    async markNextMove(who, outcome) {
      await redis.set(`mockprovider:${prefix}:next-move:${who}`, outcome);
    },

    async coverPayoutFee({ idempotencyKey }) {
      return { transferRef: `mock_transfer_${idempotencyKey}` };
    },

    async setManualPayouts() {},

    async requestPayoutCapabilities() {},

    async chooseScenario(reference, scenario) {
      const key = paymentKey(prefix, reference);
      if (!(await redis.exists(key))) return false;
      if (!(await redis.hsetnx(key, 'chosen', '1'))) return false;
      await redis.hset(key, {
        scenario,
        status: scenario === 'no-reply' ? 'succeeded' : 'pending',
      });
      return true;
    },

    async markStatus(reference, status) {
      await redis.hset(paymentKey(prefix, reference), { status });
    },

    async markMethod(reference, method) {
      await redis.hset(paymentKey(prefix, reference), { method });
    },

    async markAmount(reference, amountMinor) {
      await redis.hset(paymentKey(prefix, reference), {
        amountMinor: amountMinor.toString(),
      });
    },

    async settle(reference) {
      const scenario = (await redis.hget(
        paymentKey(prefix, reference),
        'scenario',
      )) as Scenario | null;
      if (scenario)
        await redis.hset(paymentKey(prefix, reference), {
          status: finalStatus(scenario),
        });
    },
  };
}
