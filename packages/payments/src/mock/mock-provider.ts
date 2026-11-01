import { randomUUID } from 'node:crypto';
import { mockWebhookSchema, type MockWebhook } from '@tipme/contracts';
import type { Redis } from 'ioredis';
import { UncertainProviderOutcomeError } from '../bachs/errors.js';
import type {
  PaymentProvider,
  PayoutPort,
  TransactionStatus,
  WebhookVerification,
} from '../provider.js';
import { SIGNATURE_HEADER, verifySignature } from '../signing.js';
import { attemptKey, paymentKey, payoutIdKey, payoutKey } from './keys.js';
import type { Scenario } from './scenario.js';

/** Same rounding as FEE_POLICY_V1's estimated processing fee (150 bps, half up). */
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

    async payoutBalance() {
      return { availableMinor: PRETEND_BALANCE_MINOR };
    },

    async platformBalance() {
      return { availableMinor: PRETEND_BALANCE_MINOR };
    },

    async quotePayoutFee() {
      return { feeMinor: 5000n, exact: false };
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
