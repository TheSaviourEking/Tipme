import { randomUUID } from 'node:crypto';
import { mockWebhookSchema } from '@tipme/contracts';
import type { Redis } from 'ioredis';
import type {
  PaymentProvider,
  Scenario,
  TransactionStatus,
  WebhookVerification,
} from '../provider.js';
import { SIGNATURE_HEADER, verifySignature } from '../signing.js';
import { paymentKey, payoutKey } from './keys.js';

/** Same rounding as MOCK_FEE_POLICY_V0's provider fee (150 bps, half up). */
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
]);

export interface MockProvider extends PaymentProvider {
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

  return {
    name: 'mock',

    async initializePayment({ attemptId, amountMinor, currency, scenario }) {
      const reference = `mock_pay_${randomUUID()}`;
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

    verifyWebhook(rawBody, headers, now = new Date()): WebhookVerification {
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

    async initiatePayout({ payoutId, amountMinor, currency, scenario }) {
      const reference = `mock_out_${randomUUID()}`;
      await redis.hset(payoutKey(prefix, reference), {
        payoutId,
        amountMinor: amountMinor.toString(),
        currency,
        scenario: scenario ?? 'payout-paid',
        status: 'pending',
      });
      return { providerReference: reference };
    },

    async fetchPayoutStatus(providerReference) {
      const status = await redis.hget(
        payoutKey(prefix, providerReference),
        'status',
      );
      if (status === null) return { status: 'not_found' };
      return {
        status: PAYOUT_STATUSES.has(status)
          ? (status as 'paid' | 'failed' | 'pending')
          : 'pending',
      };
    },

    async settlePayout(reference) {
      const scenario = await redis.hget(
        payoutKey(prefix, reference),
        'scenario',
      );
      if (scenario) {
        await redis.hset(payoutKey(prefix, reference), {
          status: scenario === 'payout-failed' ? 'failed' : 'paid',
        });
      }
    },

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
