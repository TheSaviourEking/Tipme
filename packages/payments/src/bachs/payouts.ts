import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  PayoutRejectedError,
  PlatformRefusalError,
  type PayoutFailureReason,
  type PayoutPort,
} from '../provider.js';
import type { BachsApiClient } from './client.js';
import {
  AmbiguousPayoutError,
  BachsApiError,
  BachsProtocolError,
  BachsRequestNotSentError,
  BachsTransportError,
  UncertainProviderOutcomeError,
} from './errors.js';
import { decimalToMinor, minorToDecimal } from './money.js';

// Bachs charges a flat fee on top of an NGN payout, and nothing states it before the payout exists:
// its payout quote "carries no fee" (docs /api-reference/payouts/create-payout-quote), and the fee
// appears only on the created payout (fee, total_debited). The default is "NGN 50 flat"
// (docs /for-you/fees), though "account-specific fees can differ", so this one value is what the
// user is shown and charged up front; any difference is settled on their balance once known.
import { NGN_PAYOUT_FEE_MINOR } from '../payout-fee.js';

// Shown on the recipient's bank statement. Without it Bachs sends its own name; keep it under
// 15 characters: https://docs.bachs.io/guides/payouts/payout-using-api.md
const PAYOUT_NARRATION = 'TipMe payout';

const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s:]+$/);

// Paying out draws on two `recipient` capabilities, and no configuration is ever applied by
// itself: https://docs.bachs.io/connect/capabilities.md
const PAYOUT_CAPABILITIES = ['payouts', 'transfers'] as const;
export const PAYOUT_CONFIGURATION = {
  recipient: {
    capabilities: {
      payouts: { requested: true },
      transfers: { requested: true },
    },
  },
} as const;

// https://docs.bachs.io/connect/payouts.md
const payoutSchema = z.object({
  id: identifierSchema,
  status: z.string().min(1),
  amount: z.string(),
  currency: z.string().min(1).max(32),
  destination: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  // The amount plus the fee actually charged, which an account's own pricing can change.
  total_debited: z.string().nullable().optional(),
  failure_reason: z.string().nullable().optional(),
});

// GET /v1/payouts?reference=: https://docs.bachs.io/api-reference/payouts/list-payouts.md
const payoutListSchema = z.object({
  total: z.number().int().nonnegative().optional(),
  items: z.array(payoutSchema),
});

// https://docs.bachs.io/api-reference/transfers/create-a-transfer.md
const transferSchema = z.object({
  id: identifierSchema,
  amount: z.string(),
  currency: z.string().min(1).max(32),
  destination: z.string(),
});

// https://docs.bachs.io/connect/balances.md
const balancesSchema = z.object({
  balances: z.array(
    z.object({ currency: z.string(), available_balance: z.string() }),
  ),
});

// https://docs.bachs.io/api-reference/payouts/update-payout-schedule.md
const balanceSettingsSchema = z.object({
  schedule_by_currency: z.record(
    z.string(),
    z.object({ interval: z.string() }),
  ),
});

// https://docs.bachs.io/api-reference/reference/list-banks.md
const banksSchema = z.object({
  banks: z.array(
    z.object({ name: z.string().min(1), code: z.string().min(1) }),
  ),
});

// https://docs.bachs.io/api-reference/misc/resolve-a-bank-account.md
const resolvedAccountSchema = z.object({
  resolved: z.boolean(),
  account_name: z.string().nullable().optional(),
});

// https://docs.bachs.io/api-reference/payouts/create-payout-destination.md
const destinationSchema = z.object({
  id: identifierSchema,
  status: z.string().min(1),
  is_usable: z.boolean().optional(),
});

// https://docs.bachs.io/connect/capabilities.md (read from the account, as in provider.ts)
const accountCapabilitySchema = z.object({
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  requirements: z
    .object({
      currently_due: z.array(z.string()).optional(),
      // https://docs.bachs.io/connect/requirements.md ("What a field blocks")
      entries: z
        .array(
          z.object({
            field: z.string(),
            status: z.string(),
            restricts_capabilities: z.array(z.string()).nullable().optional(),
          }),
        )
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

// Only these codes prove no money moved (https://docs.bachs.io/connect/payouts.md,
// https://docs.bachs.io/connect/transfers.md). Any other refusal stays unknown: a generic
// BAD_REQUEST can mean "Reference already exists", so an earlier attempt did create the payout.
const PAYOUT_REFUSALS: Readonly<Record<string, PayoutFailureReason>> = {
  ORGANIZATION_IN_DEBT: 'in_debt',
  DESTINATION_NOT_FOUND: 'destination',
  DESTINATION_PENDING_REVIEW: 'destination',
  DESTINATION_REJECTED: 'destination',
  BANK_ROUTING_DETAILS_INVALID: 'destination',
  INSUFFICIENT_BALANCE: 'other',
  VALIDATION_ERROR: 'other',
  PAYOUT_CURRENCY_NOT_ENABLED: 'other',
  PAYOUT_SOURCE_CURRENCY_UNSUPPORTED: 'other',
  PAYOUT_RECIPIENT_INCOMPLETE: 'other',
};

// On a transfer the debited side is the platform, so an empty or indebted balance here is TipMe's
// and not the recipient's: their withdrawal waits for the reserve instead of failing.
const TRANSFER_REFUSALS: Readonly<
  Record<string, PayoutFailureReason | 'reserve_empty'>
> = {
  ORGANIZATION_IN_DEBT: 'reserve_empty',
  INSUFFICIENT_BALANCE: 'reserve_empty',
  NOT_FOUND: 'other',
  VALIDATION_ERROR: 'other',
};

// Paying for Pro from the balance (plan Task 8): the debited side is the person's own account, so
// these are about their money, not TipMe's reserve. https://docs.bachs.io/connect/transfers.md
const COLLECT_REFUSALS: Readonly<Record<string, PayoutFailureReason>> = {
  ORGANIZATION_IN_DEBT: 'in_debt',
  INSUFFICIENT_BALANCE: 'other',
  NOT_FOUND: 'other',
  VALIDATION_ERROR: 'other',
};

// A transfer read back (GET /v1/transfers): `status` paid once on both balances, else pending.
const listedTransferSchema = z.object({
  id: identifierSchema,
  status: z.string().min(1),
  amount: z.string(),
  currency: z.string().min(1).max(32),
  transfer_group: z.string().nullable().optional(),
});
// The guide shows no list envelope; `items` as for payouts, or `data`.
const transferListSchema = z.union([
  z.object({ items: z.array(listedTransferSchema) }),
  z.object({ data: z.array(listedTransferSchema) }),
]);
const TRANSFER_LIST_LIMIT = 100;

const sentTransferSchema = z.object({
  id: identifierSchema,
  status: z.string().min(1),
  amount: z.string(),
  currency: z.string().min(1).max(32),
  destination: z.string(),
});

const collectedSchema = z.object({
  id: identifierSchema,
  status: z.string().min(1),
  amount: z.string(),
  currency: z.string().min(1).max(32),
});

/** Bachs's failure text is free-form: only ever an allowlisted reason leaves the adapter. */
export function payoutFailureReason(text: string): PayoutFailureReason {
  if (/debt/i.test(text)) return 'in_debt';
  // "Insufficient account balance" is about money, not about where it was going.
  if (/insufficient|balance/i.test(text)) return 'other';
  if (/destination|bank|account|beneficiary/i.test(text)) return 'destination';
  return 'other';
}

function refused(message: string): BachsRequestNotSentError {
  return new BachsRequestNotSentError(message);
}

function checkedIdentifier(value: string, label: string): string {
  if (!identifierSchema.safeParse(value).success)
    throw refused(`Invalid ${label}`);
  return value;
}

function checkedKey(value: string): string {
  if (!/^[\w.:-]{1,255}$/.test(value)) throw refused('Invalid idempotency key');
  return value;
}

function checkedAmount(amountMinor: bigint, currency: string): string {
  if (currency !== 'NGN') throw refused('Payouts are in NGN only');
  if (amountMinor <= 0n) throw refused('The amount must be above zero');
  return minorToDecimal(amountMinor, currency);
}

// A NUBAN is ten digits. The message never repeats what was typed.
function checkedAccountNumber(value: string): string {
  if (!/^\d{10}$/.test(value))
    throw refused('A bank account number must be 10 digits');
  return value;
}

function checkedBankCode(value: string): string {
  if (!/^[\w-]{1,20}$/.test(value)) throw refused('Invalid bank code');
  return value;
}

function scopedPayout(reference: string): { account: string; id: string } {
  const separator = reference.indexOf(':');
  if (separator <= 0) throw new TypeError('Invalid payout reference');
  return {
    account: checkedIdentifier(
      reference.slice(0, separator),
      'payout reference',
    ),
    id: checkedIdentifier(reference.slice(separator + 1), 'payout reference'),
  };
}

function sameMoney(amount: string, currency: string, expected: bigint) {
  try {
    return currency === 'NGN' && decimalToMinor(amount, 'NGN') === expected;
  } catch {
    return false;
  }
}

function unexpected(operation: string): UncertainProviderOutcomeError {
  return new UncertainProviderOutcomeError(
    operation,
    'the payment provider answered with different details',
    { cause: 'unexpected_state' },
  );
}

/** Runs a money write: a listed refusal is definite, every other error stays unknown. */
async function moneyWrite<T>(
  operation: string,
  refusals: Readonly<Record<string, PayoutFailureReason | 'reserve_empty'>>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof BachsApiError)) throw error;
    const code = error.providerCode;
    // TipMe's key, whatever else the answer says: nothing was done, and it isn't the recipient's.
    if (
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      code === 'UNAUTHORIZED' ||
      code === 'FORBIDDEN'
    )
      throw new PlatformRefusalError('provider_key', code);
    const reason =
      code !== undefined && Object.hasOwn(refusals, code)
        ? refusals[code]
        : undefined;
    if (reason === 'reserve_empty')
      throw new PlatformRefusalError('reserve_empty', code);
    if (reason) throw new PayoutRejectedError(reason, code);
    throw new UncertainProviderOutcomeError(
      operation,
      `the payment provider returned HTTP ${error.statusCode}`,
      {
        cause: 'http_error',
        httpStatus: error.statusCode,
        ...(code ? { providerCode: code } : {}),
      },
    );
  }
}

/** A merchant account owes more than a recipient: only what blocks paying out is listed. */
function payoutRequirements(
  requirements: z.infer<typeof accountCapabilitySchema>['requirements'],
): string[] {
  if (!requirements?.entries) return requirements?.currently_due ?? [];
  return requirements.entries
    .filter(
      (entry) =>
        (entry.status === 'currently_due' || entry.status === 'past_due') &&
        PAYOUT_CAPABILITIES.some((name) =>
          entry.restricts_capabilities?.includes(name),
        ),
    )
    .map((entry) => entry.field);
}

/** Absent when Bachs does not say or the figure makes no sense: the payout itself still stands. */
function chargedFee(
  payout: z.infer<typeof payoutSchema>,
): { feeMinor: bigint } | Record<string, never> {
  if (!payout.total_debited || payout.currency !== 'NGN') return {};
  try {
    const feeMinor =
      decimalToMinor(payout.total_debited, 'NGN') -
      decimalToMinor(payout.amount, 'NGN');
    return feeMinor >= 0n ? { feeMinor } : {};
  } catch {
    return {};
  }
}

/** What the provider says the payout is. An NGN amount that can't be read is no answer at all. */
function payoutDetails(payout: z.infer<typeof payoutSchema>): {
  amountMinor?: bigint;
  currency: string;
  destinationRef?: string;
  operationReference?: string;
} {
  const destination = {
    ...(payout.destination ? { destinationRef: payout.destination } : {}),
    ...(payout.reference ? { operationReference: payout.reference } : {}),
  };
  if (payout.currency !== 'NGN')
    return { currency: payout.currency, ...destination };
  try {
    return {
      amountMinor: decimalToMinor(payout.amount, 'NGN'),
      currency: payout.currency,
      ...destination,
    };
  } catch {
    throw new BachsProtocolError(
      'The payment provider returned an invalid payout amount',
    );
  }
}

function payoutState(payout: z.infer<typeof payoutSchema>): {
  status: 'paid' | 'failed' | 'pending' | 'review';
  failureReason?: PayoutFailureReason;
  feeMinor?: bigint;
  amountMinor?: bigint;
  currency: string;
  destinationRef?: string;
  operationReference?: string;
} {
  const status = payout.status.toLowerCase();
  const fee = { ...chargedFee(payout), ...payoutDetails(payout) };
  if (status === 'completed') return { status: 'paid', ...fee };
  if (status === 'failed')
    return {
      status: 'failed',
      failureReason: payoutFailureReason(payout.failure_reason ?? ''),
      ...fee,
    };
  if (status === 'pending' || status === 'processing')
    return { status: 'pending', ...fee };
  return { status: 'review', ...fee };
}

/** Read `is_usable`, not `status`: https://docs.bachs.io/guides/payouts/destinations.md */
function destinationStatus(
  destination: z.infer<typeof destinationSchema>,
): 'usable' | 'pending_review' | 'rejected' {
  const status = destination.status.toLowerCase();
  if (status === 'approved' && destination.is_usable === true) return 'usable';
  return status === 'rejected' ? 'rejected' : 'pending_review';
}

export function createBachsPayouts(
  client: BachsApiClient,
  apiKey: string,
): PayoutPort {
  // GET /v1/balances, with X-Account-Id for an account: https://docs.bachs.io/connect/balances.md
  async function readBalance(currency: 'NGN', accountRef?: string) {
    const { balances } = await client.request({
      method: 'GET',
      path: '/v1/balances',
      schema: balancesSchema,
      ...(accountRef ? { accountReference: accountRef } : {}),
    });
    const available = balances.find(
      (balance) => balance.currency === currency,
    )?.available_balance;
    // A currency with no activity is absent, not zero. A lost dispute can make it negative:
    // that is still nothing to spend.
    if (available === undefined || available.startsWith('-'))
      return { availableMinor: 0n };
    try {
      return { availableMinor: decimalToMinor(available, currency) };
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError)
        throw new BachsProtocolError(
          'The payment provider returned an invalid balance',
        );
      throw error;
    }
  }

  return {
    // GET /v1/accounts/{id}. Gate on `active`: https://docs.bachs.io/connect/capabilities.md
    async payoutCapability(accountRef) {
      checkedIdentifier(accountRef, 'account reference');
      let account: z.infer<typeof accountCapabilitySchema>;
      try {
        account = await client.request({
          method: 'GET',
          path: `/v1/accounts/${encodeURIComponent(accountRef)}`,
          schema: accountCapabilitySchema,
        });
      } catch (error) {
        if (error instanceof BachsApiError && error.statusCode === 404)
          return { status: 'missing', requirementsDue: [] };
        throw error;
      }
      const statuses = PAYOUT_CAPABILITIES.map((name) => {
        const capability = account.capabilities?.[name];
        return typeof capability === 'object' &&
          capability !== null &&
          'status' in capability
          ? capability.status
          : undefined;
      });
      return {
        status: statuses.some(
          (status) => status === undefined || status === 'unrequested',
        )
          ? 'missing'
          : statuses.every((status) => status === 'active')
            ? 'active'
            : 'restricted',
        requirementsDue: payoutRequirements(account.requirements),
      };
    },

    // POST /v1/accounts/{id}: naming a persona applies it to an account without it, and leaves
    // what it already holds alone: https://docs.bachs.io/connect/capabilities.md
    async requestPayoutCapabilities(accountRef) {
      checkedIdentifier(accountRef, 'account reference');
      const operation = `payout-capabilities.${accountRef}`;
      await client.request({
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(accountRef)}`,
        idempotencyKey: operation,
        operationReference: operation,
        body: { configuration: PAYOUT_CONFIGURATION },
        schema: accountCapabilitySchema,
      });
    },

    // GET /v1/reference/banks: https://docs.bachs.io/api-reference/reference/list-banks.md
    async listBanks(country) {
      const { banks } = await client.request({
        method: 'GET',
        path: `/v1/reference/banks?country=${encodeURIComponent(country)}`,
        schema: banksSchema,
      });
      return banks.map(({ code, name }) => ({ code, name }));
    },

    // POST /v1/misc/bank-accounts/resolve, a lookup that moves nothing, so it carries no key:
    // https://docs.bachs.io/api-reference/misc/resolve-a-bank-account.md
    async resolveBankAccount(input) {
      const result = await client.request({
        method: 'POST',
        path: '/v1/misc/bank-accounts/resolve',
        operationReference: 'bank-account-lookup',
        body: {
          account_number: checkedAccountNumber(input.accountNumber),
          bank_code: checkedBankCode(input.bankCode),
          country: 'NG',
        },
        schema: resolvedAccountSchema,
      });
      return result.resolved && result.account_name
        ? { accountName: result.account_name }
        : null;
    },

    // POST /v1/payouts/destinations with X-Account-Id:
    // https://docs.bachs.io/api-reference/payouts/create-payout-destination.md
    // https://docs.bachs.io/guides/payouts/destinations.md (statuses and is_usable)
    async addPayoutDestination(accountRef, input) {
      checkedIdentifier(accountRef, 'account reference');
      const accountNumber = checkedAccountNumber(input.accountNumber);
      const bankCode = checkedBankCode(input.bankCode);
      // Keyed, because hashing ten digits alone could be reversed by trying them all.
      const fingerprint = createHmac('sha256', apiKey)
        .update(`${accountRef}|${bankCode}|${accountNumber}`)
        .digest('hex')
        .slice(0, 40);
      const destination = await client.request({
        method: 'POST',
        path: '/v1/payouts/destinations',
        accountReference: accountRef,
        idempotencyKey: `destination.${fingerprint}`,
        operationReference: `destination.${accountRef}`,
        body: {
          type: 'bank_account',
          currency: 'NGN',
          bank_code: bankCode,
          account_number: accountNumber,
          // For NGN the bank resolves the name and Bachs ignores this value.
          account_name: input.accountName,
        },
        schema: destinationSchema,
      });
      const status = destinationStatus(destination);
      return {
        destinationRef: destination.id,
        usable: status === 'usable',
        status,
      };
    },

    // GET /v1/payouts/destinations/{id} with X-Account-Id:
    // https://docs.bachs.io/api-reference/payouts/get-payout-destination.md
    async payoutDestinationStatus(accountRef, destinationRef) {
      checkedIdentifier(accountRef, 'account reference');
      checkedIdentifier(destinationRef, 'payout destination');
      // A 404 throws like any failed read: it can mean a lagging read, not a rejected account.
      return destinationStatus(
        await client.request({
          method: 'GET',
          path: `/v1/payouts/destinations/${encodeURIComponent(destinationRef)}`,
          accountReference: accountRef,
          schema: destinationSchema,
        }),
      );
    },

    payoutBalance(accountRef, currency) {
      checkedIdentifier(accountRef, 'account reference');
      return readBalance(currency, accountRef);
    },

    platformBalance(currency) {
      return readBalance(currency);
    },

    async quotePayoutFee(_accountRef, _amountMinor, currency) {
      if (currency !== 'NGN') throw refused('Payouts are in NGN only');
      return { feeMinor: NGN_PAYOUT_FEE_MINOR, exact: false };
    },

    // POST /v1/transfers as the platform; the debited side is whoever authenticates:
    // https://docs.bachs.io/connect/transfers.md
    async coverPayoutFee(input) {
      const account = checkedIdentifier(input.accountRef, 'account reference');
      const idempotencyKey = checkedKey(input.idempotencyKey);
      const amount = checkedAmount(input.feeMinor, input.currency);
      const transfer = await moneyWrite(idempotencyKey, TRANSFER_REFUSALS, () =>
        client.request({
          method: 'POST',
          path: '/v1/transfers',
          idempotencyKey,
          operationReference: idempotencyKey,
          body: {
            destination: account,
            amount,
            currency: input.currency,
            description: 'Payout fee',
            // Transfers can't be looked up by key, so staff can find a lost one by this.
            transfer_group: idempotencyKey,
          },
          schema: transferSchema,
        }),
      );
      if (
        transfer.destination !== account ||
        !sameMoney(transfer.amount, transfer.currency, input.feeMinor)
      )
        throw unexpected(idempotencyKey);
      return { transferRef: transfer.id };
    },

    // POST /v1/transfers AS the account (X-Account-Id), `destination: "self"`: the account's
    // available balance moves to TipMe's own. https://docs.bachs.io/connect/transfers.md
    async collectToPlatform(input) {
      const account = checkedIdentifier(input.accountRef, 'account reference');
      const idempotencyKey = checkedKey(input.idempotencyKey);
      const amount = checkedAmount(input.amountMinor, input.currency);
      const transfer = await moneyWrite(idempotencyKey, COLLECT_REFUSALS, () =>
        client.request({
          method: 'POST',
          path: '/v1/transfers',
          accountReference: account,
          idempotencyKey,
          operationReference: idempotencyKey,
          body: {
            destination: 'self',
            amount,
            currency: input.currency,
            description: input.description ?? 'TipMe Pro',
            // Listing can't filter by it, but every transfer returns it: the read-back finds ours.
            transfer_group: idempotencyKey,
          },
          schema: collectedSchema,
        }),
      );
      if (!sameMoney(transfer.amount, transfer.currency, input.amountMinor))
        throw unexpected(idempotencyKey);
      return {
        transferRef: transfer.id,
        status: transfer.status.toLowerCase() === 'paid' ? 'paid' : 'pending',
      };
    },

    // POST /v1/transfers as the platform: TipMe's balance to an account (option B's second leg, and a
    // refunded tip's fee going back). https://docs.bachs.io/connect/transfers.md
    async transferToAccount(input) {
      const account = checkedIdentifier(input.accountRef, 'account reference');
      const idempotencyKey = checkedKey(input.idempotencyKey);
      const amount = checkedAmount(input.amountMinor, input.currency);
      const transfer = await moneyWrite(idempotencyKey, TRANSFER_REFUSALS, () =>
        client.request({
          method: 'POST',
          path: '/v1/transfers',
          idempotencyKey,
          operationReference: idempotencyKey,
          body: {
            destination: account,
            amount,
            currency: input.currency,
            description: input.description,
            // Every transfer returns it, so the read-back finds ours among the account's.
            transfer_group: idempotencyKey,
          },
          schema: sentTransferSchema,
        }),
      );
      if (
        transfer.destination !== account ||
        !sameMoney(transfer.amount, transfer.currency, input.amountMinor)
      )
        throw unexpected(idempotencyKey);
      return {
        transferRef: transfer.id,
        status: transfer.status.toLowerCase() === 'paid' ? 'paid' : 'pending',
      };
    },

    // GET /v1/transfers?connected_account_id=, newest first, matched on our transfer_group.
    async findPlatformCollection(accountRef, idempotencyKey) {
      const account = checkedIdentifier(accountRef, 'account reference');
      const key = checkedKey(idempotencyKey);
      let listed: z.infer<typeof transferListSchema>;
      try {
        listed = await client.request({
          method: 'GET',
          path: `/v1/transfers?connected_account_id=${encodeURIComponent(account)}&limit=${TRANSFER_LIST_LIMIT}`,
          schema: transferListSchema,
        });
      } catch (error) {
        throw new UncertainProviderOutcomeError(
          key,
          'the transfers could not be read back',
          error instanceof BachsApiError
            ? { cause: 'http_error', httpStatus: error.statusCode }
            : { cause: 'unreadable_response' },
        );
      }
      const items = 'items' in listed ? listed.items : listed.data;
      const ours = items.find((item) => item.transfer_group === key);
      if (!ours) {
        // A full page may have pushed ours off it: absence there proves nothing.
        if (items.length >= TRANSFER_LIST_LIMIT)
          throw new UncertainProviderOutcomeError(
            key,
            'too many transfers to be sure',
            { cause: 'unexpected_shape' },
          );
        return null;
      }
      let amountMinor: bigint;
      try {
        amountMinor = decimalToMinor(ours.amount, ours.currency);
      } catch {
        throw unexpected(key);
      }
      return {
        transferRef: ours.id,
        status: ours.status.toLowerCase() === 'paid' ? 'paid' : 'pending',
        amountMinor,
        currency: ours.currency,
      };
    },

    // POST /v1/balance_settings with X-Account-Id. A schedule is set per currency:
    // https://docs.bachs.io/api-reference/payouts/update-payout-schedule.md
    async setManualPayouts(accountRef) {
      checkedIdentifier(accountRef, 'account reference');
      const operation = `balance-settings.${accountRef}.manual`;
      const settings = await client.request({
        method: 'POST',
        path: '/v1/balance_settings',
        accountReference: accountRef,
        idempotencyKey: operation,
        operationReference: operation,
        body: { schedule_by_currency: { NGN: { interval: 'manual' } } },
        schema: balanceSettingsSchema,
      });
      if (settings.schedule_by_currency['NGN']?.interval !== 'manual')
        throw unexpected(operation);
    },

    // POST /v1/payouts with X-Account-Id; `amount` is what the bank receives, the fee is on top:
    // https://docs.bachs.io/connect/payouts.md
    async initiatePayout(input) {
      const account = checkedIdentifier(input.accountRef, 'account reference');
      const destination = checkedIdentifier(
        input.destinationRef,
        'payout destination',
      );
      const idempotencyKey = checkedKey(input.idempotencyKey);
      // Bachs allows letters, digits, `.`, `-` and `_` in a reference.
      if (!/^[\w.-]{1,128}$/.test(input.payoutId))
        throw refused('Invalid payout id');
      const amount = checkedAmount(input.amountMinor, input.currency);
      const payout = await moneyWrite(idempotencyKey, PAYOUT_REFUSALS, () =>
        client.request({
          method: 'POST',
          path: '/v1/payouts',
          accountReference: account,
          idempotencyKey,
          operationReference: idempotencyKey,
          body: {
            destination,
            amount,
            reference: input.payoutId,
            narration: PAYOUT_NARRATION,
          },
          schema: payoutSchema,
        }),
      );
      if (
        !sameMoney(payout.amount, payout.currency, input.amountMinor) ||
        (payout.destination != null && payout.destination !== destination)
      )
        throw unexpected(idempotencyKey);
      const status = payout.status.toLowerCase();
      return {
        // Bachs reads a payout through its account, so the reference names both.
        providerReference: `${account}:${payout.id}`,
        // A replayed request can already be final: the outcome still comes from a webhook or a
        // read. Bachs documents no review status, and holds at `pending`; anything TipMe does not
        // know is treated as under review.
        status:
          status === 'pending'
            ? 'pending'
            : status === 'processing' ||
                status === 'completed' ||
                status === 'failed'
              ? 'processing'
              : 'review',
        ...chargedFee(payout),
      };
    },

    // GET /v1/payouts/{id} with X-Account-Id:
    // https://docs.bachs.io/api-reference/payouts/get-payout.md
    async fetchPayoutStatus(providerReference) {
      const { account, id } = scopedPayout(providerReference);
      let payout: z.infer<typeof payoutSchema>;
      try {
        payout = await client.request({
          method: 'GET',
          path: `/v1/payouts/${encodeURIComponent(id)}`,
          accountReference: account,
          schema: payoutSchema,
        });
      } catch (error) {
        if (error instanceof BachsApiError && error.statusCode === 404)
          return { status: 'not_found' };
        throw error;
      }
      return payoutState(payout);
    },

    // GET /v1/payouts?reference=, at most one by the docs. The reference schema says 128 at most:
    // https://docs.bachs.io/api-reference/payouts/list-payouts.md
    async findPayoutByReference(accountRef, payoutId) {
      const account = checkedIdentifier(accountRef, 'account reference');
      if (!/^[\w.-]{1,128}$/.test(payoutId)) throw refused('Invalid payout id');
      const operation = `payout-lookup.${payoutId}`;
      let list: z.infer<typeof payoutListSchema>;
      try {
        list = await client.request({
          method: 'GET',
          path: `/v1/payouts?reference=${encodeURIComponent(payoutId)}`,
          accountReference: account,
          schema: payoutListSchema,
        });
      } catch (error) {
        if (!(
          error instanceof BachsApiError ||
          error instanceof BachsProtocolError ||
          error instanceof BachsTransportError
        ))
          throw error;
        // A null here could release money that has left, so no failed read may look like one.
        throw new UncertainProviderOutcomeError(
          operation,
          'the payment provider could not say whether the payout exists',
          error instanceof BachsApiError
            ? {
                cause: 'http_error',
                httpStatus: error.statusCode,
                ...(error.providerCode
                  ? { providerCode: error.providerCode }
                  : {}),
              }
            : {
                cause:
                  error instanceof BachsProtocolError
                    ? 'unexpected_shape'
                    : 'no_response',
              },
        );
      }
      // The docs define "none" as empty with `total` 0. An empty list alone could be a changed
      // envelope, and null is what lets a reservation be released.
      if (list.total === 0 && list.items.length === 0) return null;
      const total = list.total ?? list.items.length;
      const payout = list.items[0];
      if (total > 1 || list.items.length > 1)
        throw new AmbiguousPayoutError(operation);
      if (
        total !== 1 ||
        list.items.length !== 1 ||
        payout?.reference !== payoutId
      )
        throw unexpected(operation);
      try {
        return {
          providerReference: `${account}:${payout.id}`,
          ...payoutState(payout),
        };
      } catch {
        throw unexpected(operation);
      }
    },
  };
}
