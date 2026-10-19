/**
 * Custody-neutral chart of accounts (ADR-0006). Codes are illustrative pending finance sign-off.
 * Balances owed to recipients are a payable, never a "wallet" (PRD 6.4).
 */
export type AccountCode =
  | 'provider_clearing'
  | 'recipient_payable'
  | 'platform_fee_revenue'
  | 'provider_fee_expense'
  | 'provider_fee_recovered'
  // What TipMe gives recipients from its own pocket (cash rewards, PR-008).
  | 'promotions_expense';

export interface LedgerLine {
  account: AccountCode;
  profileId?: string;
  side: 'debit' | 'credit';
  amountMinor: bigint;
}

export interface PaymentPostingInput {
  grossMinor: bigint;
  platformFeeMinor: bigint;
  quotedProviderFeeMinor: bigint;
  actualProviderFeeMinor: bigint;
  recipientNetMinor: bigint;
  profileId: string;
}

const line = (
  account: AccountCode,
  side: LedgerLine['side'],
  amountMinor: bigint,
  profileId?: string,
): LedgerLine =>
  profileId
    ? { account, side, amountMinor, profileId }
    : { account, side, amountMinor };

/**
 * The provider collects the gross and withholds its actual fee. The quoted fee was taken from the
 * tip (recovered), the actual fee is an expense: their difference is the fee variance TipMe absorbs,
 * so the recipient's net is always exactly what the quote promised.
 */
export function buildPaymentPosting(input: PaymentPostingInput): LedgerLine[] {
  const {
    grossMinor,
    platformFeeMinor,
    quotedProviderFeeMinor,
    actualProviderFeeMinor,
    recipientNetMinor,
  } = input;
  if (
    grossMinor !==
    platformFeeMinor + quotedProviderFeeMinor + recipientNetMinor
  ) {
    throw new RangeError('fee breakdown does not add up to the gross amount');
  }
  if (actualProviderFeeMinor < 0n || actualProviderFeeMinor > grossMinor) {
    throw new RangeError('provider fee out of range');
  }
  return [
    line('provider_clearing', 'debit', grossMinor - actualProviderFeeMinor),
    line('provider_fee_expense', 'debit', actualProviderFeeMinor),
    line('platform_fee_revenue', 'credit', platformFeeMinor),
    line('provider_fee_recovered', 'credit', quotedProviderFeeMinor),
    line('recipient_payable', 'credit', recipientNetMinor, input.profileId),
  ].filter((entry) => entry.amountMinor > 0n);
}

/** Paying a recipient settles what TipMe owed them out of the provider balance. */
export function buildPayoutPosting({
  amountMinor,
  profileId,
}: {
  amountMinor: bigint;
  profileId: string;
}): LedgerLine[] {
  if (amountMinor <= 0n) throw new RangeError('payout amount must be positive');
  return [
    line('recipient_payable', 'debit', amountMinor, profileId),
    line('provider_clearing', 'credit', amountMinor),
  ];
}

/** A cash reward from TipMe: its own promotional cost, owed to the recipient like a tip. */
export function buildRewardPosting({
  amountMinor,
  profileId,
}: {
  amountMinor: bigint;
  profileId: string;
}): LedgerLine[] {
  if (amountMinor <= 0n) throw new RangeError('reward amount must be positive');
  return [
    line('promotions_expense', 'debit', amountMinor),
    line('recipient_payable', 'credit', amountMinor, profileId),
  ];
}

export function isBalanced(lines: readonly LedgerLine[]): boolean {
  let total = 0n;
  for (const entry of lines)
    total += entry.side === 'debit' ? entry.amountMinor : -entry.amountMinor;
  return lines.length >= 2 && total === 0n;
}
