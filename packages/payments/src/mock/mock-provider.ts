import { randomUUID } from 'node:crypto';
import { mockWebhookSchema, type MockWebhook } from '@tipme/contracts';
import type { Redis } from 'ioredis';
import { UncertainProviderOutcomeError } from '../bachs/errors.js';
import {
  CollectTransferRefusedError,
  DisputeEvidenceRefusedError,
  PayoutRejectedError,
  PlatformRefusalError,
  ProRefundRefusedError,
  SavedCardRefusedError,
  TipRefundRefusedError,
} from '../provider.js';
import type {
  DisputeStatus,
  PaymentProvider,
  PayoutPort,
  TransactionStatus,
  WebhookVerification,
} from '../provider.js';
import { SIGNATURE_HEADER, verifySignature } from '../signing.js';
import { NGN_PAYOUT_FEE_MINOR } from '../payout-fee.js';
import {
  accountTransfersKey,
  attemptKey,
  collectAnswerKey,
  collectTransferKey,
  destinationKey,
  disputeEvidenceKey,
  disputeKey,
  disputesKey,
  paymentKey,
  payoutIdKey,
  payoutKey,
  platformBalancesKey,
} from './keys.js';
import type { CollectScenario, Scenario } from './scenario.js';

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

/** What each refusing collect scenario answers, as the partner's code (R9). */
const COLLECT_REFUSALS = {
  'collect-insufficient': ['insufficient', 'INSUFFICIENT_BALANCE'],
  'collect-forbidden': ['capability', 'FORBIDDEN'],
  'collect-in-debt': ['in_debt', 'ORGANIZATION_IN_DEBT'],
  'collect-not-found': ['not_found', 'NOT_FOUND'],
} as const;

/** TipMe's own balance and schedule scenarios have one slot each, whatever key they were set for. */
const PLATFORM_SLOT: Partial<Record<CollectScenario, string>> = {
  'balance-usd-negative': 'platform:balances',
  'auto-payout-on': 'platform:schedule',
};

type PlatformBalanceRow = {
  currency: string;
  availableMinor: bigint;
  pendingMinor: bigint;
};

const mismatched = (key: string) =>
  new UncertainProviderOutcomeError(
    key,
    'the payment provider answered with different details',
    { cause: 'unexpected_state' },
  );

const lostAnswer = (key: string) =>
  new UncertainProviderOutcomeError(
    key,
    'the request may have reached the payment provider but its response was not received',
    { cause: 'no_response' },
  );

const FINAL_DISPUTE: ReadonlySet<string> = new Set(['won', 'lost', 'closed']);

/** A pretend dispute's webhook body, as the mock webhook contract reads it. */
function disputeWebhook(
  type: 'dispute.created' | 'dispute.updated',
  disputeId: string,
  dispute: Record<string, string>,
): MockWebhook {
  return {
    id: `evt_${randomUUID()}`,
    type,
    data: {
      reference: dispute['chargeReference'] ?? disputeId,
      disputeId,
      status: dispute['status'] as DisputeStatus,
      respondBy: dispute['respondBy']!,
      amountMinor: dispute['amountMinor']!,
      currency: dispute['currency']!,
      feeMinor: dispute['feeMinor']!,
      feeCurrency: dispute['feeCurrency']!,
    },
  };
}

export interface MockProvider
  extends
    Omit<PaymentProvider<MockWebhook>, keyof PayoutPort>,
    Omit<PayoutPort, 'initiatePayout'> {
  /** Test control: what `payoutBalance` answers for one account; null brings the pretend figure back. */
  markPayoutBalance(
    accountRef: string,
    availableMinor: bigint | null,
  ): Promise<void>;
  /** Pretend money is never live: a collect tip's transfer records `sandbox` (plan Task 7). */
  readonly environment: 'sandbox';
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
  /**
   * You collect: how the pretend partner answers next, used once. `collect-*` answers the transfer
   * with this idempotency key; `destination-*` the next destination added to this account;
   * `balance-usd-negative` and `auto-payout-on` the next read of TipMe's balances or schedule
   * (any key).
   */
  markCollectAnswer(key: string, scenario: CollectScenario): Promise<void>;
  /** You collect: TipMe's pretend balances, signed, until set again. */
  markPlatformBalances(rows: readonly PlatformBalanceRow[]): Promise<void>;
  /** Moves the pretend payout to the status its scenario ends in. */
  settlePayout(reference: string): Promise<void>;
  /**
   * You collect (plan Task 5): the pretend partner opens a dispute on one of TipMe's own charges and
   * returns its `dispute.created` webhook body, to deliver with runScenario. It reports the flat
   * fee the real partner charges ($15 unless given), which the real partner's docs never name.
   * Dev and e2e only: the mock provider is refused in production at startup.
   */
  raiseDispute(input: {
    chargeReference: string;
    amountMinor: bigint;
    currency: string;
    respondBy?: Date;
    feeMinor?: bigint;
    feeCurrency?: string;
  }): Promise<MockWebhook>;
  /** Moves a pretend dispute on and returns its `dispute.updated` body. A final one can't move. */
  decideDispute(
    disputeId: string,
    status: Exclude<DisputeStatus, 'open'>,
  ): Promise<MockWebhook>;
}

/**
 * A local stand-in for a real provider. Never usable in production (refused at startup).
 * Without a secret (e.g. in the worker, which never receives webhooks) every webhook is rejected.
 */
export function createMockProvider(options: {
  redis: Redis;
  secret?: string;
  prefix?: string;
  /** `mock_alt` is a second, test-only instance: its own name and its own keys. */
  name?: 'mock' | 'mock_alt';
}): MockProvider {
  const { redis } = options;
  const secret = options.secret ?? '';
  const name = options.name ?? 'mock';
  const basePrefix = options.prefix ?? 'default';
  // `mock` keeps today's keys; `mock_alt` can never read or write them.
  const prefix = name === 'mock' ? basePrefix : `${basePrefix}:mock_alt`;
  const balanceKey = (accountRef: string) =>
    `mockprovider:${prefix}:payout-balance:${accountRef}`;

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
    name,
    environment: 'sandbox',
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

    /**
     * You collect: a pretend tip checkout on TipMe's own account, `platform:mock_collect_<uuid>`,
     * one per attempt (found by the attempt id, like a tip's). TipMe bears the fee; card unless set.
     */
    async initializeCollectCheckout({ attemptId, amountMinor, currency }) {
      const reference = `platform:mock_collect_${randomUUID()}` as const;
      const claimed = await redis.set(
        attemptKey(prefix, attemptId),
        reference,
        'NX',
      );
      const existing =
        claimed === 'OK'
          ? null
          : await redis.get(attemptKey(prefix, attemptId));
      const providerReference = (existing ?? reference) as `platform:${string}`;
      if (claimed === 'OK')
        await redis.hset(paymentKey(prefix, reference), {
          attemptId,
          collect: '1',
          amountMinor: amountMinor.toString(),
          currency,
          feeMinor: mockProviderFee(amountMinor).toString(),
          scenario: 'succeed',
          status: 'pending',
          method: 'NGN_CARD',
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
        ...(stored['purchaseId'] || stored['charge'] || stored['collect']
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
      const reference = `${name}_out_${idempotencyKey}`;
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

    async addPayoutDestination(
      accountRef,
      { accountNumber, bankCode, nameDigest },
    ) {
      // You collect: like the partner, one add per key (the account, bank, number and checked name):
      // the same name again replays its first answer, a corrected name is a fresh check.
      const destinationRef = `mock_dest_${accountRef}_${bankCode}_${accountNumber.slice(-4)}${nameDigest ? `_${nameDigest.slice(0, 12)}` : ''}`;
      if (nameDigest) {
        const replayed = await redis.get(
          destinationKey(prefix, destinationRef),
        );
        if (
          replayed === 'usable' ||
          replayed === 'pending_review' ||
          replayed === 'rejected'
        )
          return {
            destinationRef,
            usable: replayed === 'usable',
            status: replayed,
          };
      }
      // You collect: a destination told to wait for review, or be refused, once.
      const answer = await redis.getdel(collectAnswerKey(prefix, accountRef));
      const status =
        answer === 'destination-pending-review'
          ? ('pending_review' as const)
          : answer === 'destination-rejected'
            ? ('rejected' as const)
            : ('usable' as const);
      if (status === 'usable' && !nameDigest)
        await redis.del(destinationKey(prefix, destinationRef));
      else await redis.set(destinationKey(prefix, destinationRef), status);
      return { destinationRef, usable: status === 'usable', status };
    },

    async payoutDestinationStatus(_accountRef, destinationRef) {
      const status = await redis.get(destinationKey(prefix, destinationRef));
      return status === 'pending_review' || status === 'rejected'
        ? status
        : 'usable';
    },

    async payoutBalance(accountRef) {
      const marked = await redis.get(balanceKey(accountRef));
      return {
        availableMinor:
          marked === null ? PRETEND_BALANCE_MINOR : BigInt(marked),
      };
    },

    async markPayoutBalance(accountRef, availableMinor) {
      if (availableMinor === null) await redis.del(balanceKey(accountRef));
      else await redis.set(balanceKey(accountRef), availableMinor.toString());
    },

    async platformBalance() {
      return { availableMinor: PRETEND_BALANCE_MINOR };
    },

    async quotePayoutFee() {
      return { feeMinor: NGN_PAYOUT_FEE_MINOR, exact: false };
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

    // You collect: TipMe's balance to a recipient's account, once per key. A refusing scenario moves
    // nothing; the next send with that key pays. The list keeps every transfer under its account.
    async sendCollectTransfer({ accountRef, amountMinor, idempotencyKey }) {
      const stored = await redis.hgetall(
        collectTransferKey(prefix, idempotencyKey),
      );
      // The same key replays the transfer it made, as live does. Checked like the real adapter
      // checks an answer: one naming other money or another account (a mismatch) stays uncertain.
      if (stored['transferRef']) {
        if (
          stored['amountMinor'] !== amountMinor.toString() ||
          stored['accountRef'] !== accountRef
        )
          throw mismatched(idempotencyKey);
        return { transferRef: stored['transferRef'], status: 'paid' };
      }
      const answer = (await redis.getdel(
        collectAnswerKey(prefix, idempotencyKey),
      )) as CollectScenario | null;
      if (answer && Object.hasOwn(COLLECT_REFUSALS, answer)) {
        const [reason, code] =
          COLLECT_REFUSALS[answer as keyof typeof COLLECT_REFUSALS];
        throw new CollectTransferRefusedError(reason, code);
      }
      const transferRef = `mock_collect_tr_${idempotencyKey}`;
      // A mismatch: the pretend partner moved one kobo more than asked.
      const moved =
        answer === 'collect-mismatch' ? amountMinor + 1n : amountMinor;
      const created = await redis.hsetnx(
        collectTransferKey(prefix, idempotencyKey),
        'transferRef',
        transferRef,
      );
      if (created) {
        await redis.hset(collectTransferKey(prefix, idempotencyKey), {
          accountRef,
          amountMinor: moved.toString(),
          currency: 'NGN',
        });
        await redis.rpush(
          accountTransfersKey(prefix, accountRef),
          idempotencyKey,
        );
      }
      if (answer === 'collect-no-reply') throw lostAnswer(idempotencyKey);
      if (answer === 'collect-mismatch') throw mismatched(idempotencyKey);
      return { transferRef, status: 'paid' };
    },

    // Newest first, like the partner's list; every transfer carries its key as its group.
    async listAccountTransfers(accountRef) {
      const keys = await redis.lrange(
        accountTransfersKey(prefix, accountRef),
        0,
        -1,
      );
      const transfers = [];
      for (const key of keys.reverse()) {
        const stored = await redis.hgetall(collectTransferKey(prefix, key));
        if (!stored['transferRef']) continue;
        transfers.push({
          transferRef: stored['transferRef'],
          status: 'paid' as const,
          amountMinor: BigInt(stored['amountMinor'] ?? '0'),
          currency: stored['currency'] ?? 'NGN',
          group: key,
        });
      }
      return transfers;
    },

    async platformBalances() {
      const marked = await redis.get(platformBalancesKey(prefix));
      const rows: PlatformBalanceRow[] = marked
        ? (
            JSON.parse(marked) as {
              currency: string;
              availableMinor: string;
              pendingMinor: string;
            }[]
          ).map((row) => ({
            currency: row.currency,
            availableMinor: BigInt(row.availableMinor),
            pendingMinor: BigInt(row.pendingMinor),
          }))
        : [
            {
              currency: 'NGN',
              availableMinor: PRETEND_BALANCE_MINOR,
              pendingMinor: 0n,
            },
          ];
      const negative = await redis.getdel(
        collectAnswerKey(prefix, PLATFORM_SLOT['balance-usd-negative']!),
      );
      // A lost dispute's $15 fee drove USD below zero (P5).
      if (negative)
        return [
          ...rows.filter((row) => row.currency !== 'USD'),
          { currency: 'USD', availableMinor: -1500n, pendingMinor: 0n },
        ];
      return rows;
    },

    async platformPayoutSchedule() {
      const on = await redis.getdel(
        collectAnswerKey(prefix, PLATFORM_SLOT['auto-payout-on']!),
      );
      return { NGN: on ? 'daily' : 'manual' };
    },

    async markCollectAnswer(key, scenario) {
      await redis.set(
        collectAnswerKey(prefix, PLATFORM_SLOT[scenario] ?? key),
        scenario,
      );
    },

    async markPlatformBalances(rows) {
      await redis.set(
        platformBalancesKey(prefix),
        JSON.stringify(
          rows.map((row) => ({
            currency: row.currency,
            availableMinor: row.availableMinor.toString(),
            pendingMinor: row.pendingMinor.toString(),
          })),
        ),
      );
    },

    async raiseDispute({
      chargeReference,
      amountMinor,
      currency,
      respondBy = new Date(Date.now() + 10 * 24 * 60 * 60_000),
      feeMinor = 1500n,
      feeCurrency = 'USD',
    }) {
      const disputeId = `mock_dsp_${randomUUID()}`;
      const raisedAt = Date.now();
      const dispute = {
        chargeReference,
        amountMinor: amountMinor.toString(),
        currency,
        respondBy: respondBy.toISOString(),
        feeMinor: feeMinor.toString(),
        feeCurrency,
        status: 'open',
      };
      await redis
        .multi()
        .hset(disputeKey(prefix, disputeId), dispute)
        .zadd(disputesKey(prefix), raisedAt, disputeId)
        .exec();
      return disputeWebhook('dispute.created', disputeId, dispute);
    },

    async decideDispute(disputeId, status) {
      const dispute = await redis.hgetall(disputeKey(prefix, disputeId));
      if (!dispute['status']) throw new Error('No such pretend dispute');
      if (FINAL_DISPUTE.has(dispute['status']))
        throw new Error('The pretend dispute is already decided');
      await redis.hset(disputeKey(prefix, disputeId), 'status', status);
      return disputeWebhook('dispute.updated', disputeId, {
        ...dispute,
        status,
      });
    },

    // Once per key, as the real partner: a repeat answers the same; a new key after submitting, or
    // on a decided dispute, is refused.
    async submitDisputeEvidence({ partnerDisputeId, idempotencyKey }) {
      const claimed = await redis.set(
        disputeEvidenceKey(prefix, idempotencyKey),
        partnerDisputeId,
        'NX',
      );
      if (claimed !== 'OK') {
        const earlier = await redis.get(
          disputeEvidenceKey(prefix, idempotencyKey),
        );
        if (earlier === partnerDisputeId) return { state: 'submitted' };
        throw new DisputeEvidenceRefusedError('CONFLICT');
      }
      const status = await redis.hget(
        disputeKey(prefix, partnerDisputeId),
        'status',
      );
      if (status !== 'open') {
        await redis.del(disputeEvidenceKey(prefix, idempotencyKey));
        throw new DisputeEvidenceRefusedError('VALIDATION_ERROR');
      }
      await redis.hset(
        disputeKey(prefix, partnerDisputeId),
        'status',
        'responded',
      );
      return { state: 'submitted' };
    },

    async uploadDisputeFile() {
      return { fileRef: `mock_upl_${randomUUID()}` };
    },

    async listDisputes(since) {
      const ids = await redis.zrevrangebyscore(
        disputesKey(prefix),
        '+inf',
        since.getTime(),
      );
      const rows = [];
      for (const id of ids) {
        const dispute = await redis.hgetall(disputeKey(prefix, id));
        rows.push({
          partnerDisputeId: id,
          status: dispute['status'] as DisputeStatus,
          amountMinor: BigInt(dispute['amountMinor'] ?? '0'),
          currency: dispute['currency'] ?? 'XXX',
          chargeReference: dispute['chargeReference'] ?? null,
        });
      }
      return rows;
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

    // Staff "Refund tip": the pretend partner refunds a tip once per payment. A tip it was told was
    // paid by bank transfer (`mockprovider:<prefix>:method:<reference>`) can't be refunded.
    async readAccountCharge(providerReference) {
      const method =
        (await redis.get(
          `mockprovider:${prefix}:method:${providerReference}`,
        )) === 'bank_transfer'
          ? ('bank_transfer' as const)
          : ('card' as const);
      const refunded = await redis.exists(
        `mockprovider:${prefix}:tip-refund:${providerReference}`,
      );
      return {
        chargeReference: `mock_ch_${providerReference}`,
        method,
        refundable: method === 'card' && refunded === 0,
      };
    },

    async refundAccountCharge({ providerReference, reference }) {
      const charge = await this.readAccountCharge!(providerReference);
      if (charge.method === 'bank_transfer')
        throw new TipRefundRefusedError('bank_transfer');
      const claimed = await redis.set(
        `mockprovider:${prefix}:tip-refund:${providerReference}`,
        reference,
        'NX',
      );
      if (claimed !== 'OK') {
        const existing = await redis.get(
          `mockprovider:${prefix}:tip-refund:${providerReference}`,
        );
        if (existing !== reference)
          throw new TipRefundRefusedError('not_refundable');
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
