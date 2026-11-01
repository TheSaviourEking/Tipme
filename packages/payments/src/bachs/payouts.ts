import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  PayoutRejectedError,
  type PayoutFailureReason,
  type PayoutPort,
} from '../provider.js';
import type { BachsApiClient } from './client.js';
import {
  BachsApiError,
  BachsProtocolError,
  BachsRequestNotSentError,
  UncertainProviderOutcomeError,
} from './errors.js';
import { decimalToMinor, minorToDecimal } from './money.js';

// Bachs charges this flat fee on top of an NGN payout and offers no same-currency quote:
// https://docs.bachs.io/guides/payouts/payout-using-api.md ("The fee is charged on top").
const NGN_PAYOUT_FEE_MINOR = 5000n;

// Shown on the recipient's bank statement. Without it Bachs sends its own name; keep it under
// 15 characters: https://docs.bachs.io/guides/payouts/payout-using-api.md
const PAYOUT_NARRATION = 'TipMe payout';

const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s:]+$/);

// https://docs.bachs.io/connect/payouts.md
const payoutSchema = z.object({
  id: identifierSchema,
  status: z.string().min(1),
  amount: z.string(),
  currency: z.string().min(1).max(32),
  destination: z.string().nullable().optional(),
  failure_reason: z.string().nullable().optional(),
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
    .object({ currently_due: z.array(z.string()).optional() })
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
  FORBIDDEN: 'other',
  UNAUTHORIZED: 'other',
  VALIDATION_ERROR: 'other',
  PAYOUT_CURRENCY_NOT_ENABLED: 'other',
  PAYOUT_SOURCE_CURRENCY_UNSUPPORTED: 'other',
  PAYOUT_RECIPIENT_INCOMPLETE: 'other',
};

// On a transfer the debited side is the platform, so a debt here is TipMe's and not the
// recipient's: it must not read as 'in_debt', which pauses the recipient's withdrawals.
const TRANSFER_REFUSALS: Readonly<Record<string, PayoutFailureReason>> = {
  ORGANIZATION_IN_DEBT: 'other',
  INSUFFICIENT_BALANCE: 'other',
  FORBIDDEN: 'other',
  UNAUTHORIZED: 'other',
  NOT_FOUND: 'other',
  VALIDATION_ERROR: 'other',
};

/** Bachs's failure text is free-form: only ever an allowlisted reason leaves the adapter. */
export function payoutFailureReason(text: string): PayoutFailureReason {
  if (/debt/i.test(text)) return 'in_debt';
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
  refusals: Readonly<Record<string, PayoutFailureReason>>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof BachsApiError)) throw error;
    const code = error.providerCode;
    const reason =
      code !== undefined && Object.hasOwn(refusals, code)
        ? refusals[code]
        : undefined;
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
      const capability = account.capabilities?.['payouts'];
      const status =
        typeof capability === 'object' &&
        capability !== null &&
        'status' in capability
          ? capability.status
          : undefined;
      return {
        status:
          status === 'active'
            ? 'active'
            : status === undefined || status === 'unrequested'
              ? 'missing'
              : 'restricted',
        requirementsDue: account.requirements?.currently_due ?? [],
      };
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
      const status = destination.status.toLowerCase();
      const usable = status === 'approved' && destination.is_usable === true;
      return {
        destinationRef: destination.id,
        usable,
        status: usable
          ? 'usable'
          : status === 'rejected'
            ? 'rejected'
            : 'pending_review',
      };
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
      if (!/^[\w.-]{1,200}$/.test(input.payoutId))
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
      const status = payout.status.toLowerCase();
      if (status === 'completed') return { status: 'paid' };
      if (status === 'failed')
        return {
          status: 'failed',
          failureReason: payoutFailureReason(payout.failure_reason ?? ''),
        };
      if (status === 'pending' || status === 'processing')
        return { status: 'pending' };
      return { status: 'review' };
    },
  };
}
