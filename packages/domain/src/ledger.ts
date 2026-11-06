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
  | 'promotions_expense'
  // What TipMe owes a business: its agreed share of staff tips (business release 2), on the
  // business's own account. Only a payment with a share credits it.
  | 'business_payable';

export interface LedgerLine {
  account: AccountCode;
  profileId?: string;
  /** The business of a `business_payable` line, as `profileId` is the person's. */
  businessId?: string;
  side: 'debit' | 'credit';
  amountMinor: bigint;
}

export interface PaymentPostingInput {
  grossMinor: bigint;
  platformFeeMinor: bigint;
  quotedProviderFeeMinor: bigint;
  actualProviderFeeMinor: bigint;
  recipientNetMinor: bigint;
  /** The person tipped. Exactly one of this and `teamSplits`. */
  profileId?: string;
  /**
   * Business release 2: the business's agreed share of the person's net (Q9), fixed on the tip at
   * intent time. It is taken from the net only, so TipMe's fee and the supporter's total are
   * unchanged; the person keeps at least half.
   */
  businessShare?: { businessId: string; amountMinor: bigint };
  /** Business release 2: a team tip's net, split among the people on shift (M17). No share (Q10). */
  teamSplits?: readonly { profileId: string; amountMinor: bigint }[];
}

const line = (
  account: AccountCode,
  side: LedgerLine['side'],
  amountMinor: bigint,
  profileId?: string,
  businessId?: string,
): LedgerLine => ({
  account,
  side,
  amountMinor,
  ...(profileId ? { profileId } : {}),
  ...(businessId ? { businessId } : {}),
});

/** Who the net goes to: one person, a person and their business, or each person of a team. */
function payableLines(input: PaymentPostingInput): LedgerLine[] {
  const {
    recipientNetMinor: net,
    profileId,
    businessShare,
    teamSplits,
  } = input;
  if ((profileId === undefined) === (teamSplits === undefined))
    throw new RangeError('a payment goes to one person or to a team');
  if (teamSplits) {
    if (businessShare) throw new RangeError('a team tip carries no share');
    let total = 0n;
    for (const split of teamSplits) {
      if (split.amountMinor <= 0n)
        throw new RangeError('every team part is positive');
      total += split.amountMinor;
    }
    if (teamSplits.length === 0 || total !== net)
      throw new RangeError('team parts do not add up to the net');
    return teamSplits.map((split) =>
      line('recipient_payable', 'credit', split.amountMinor, split.profileId),
    );
  }
  if (!businessShare)
    return [line('recipient_payable', 'credit', net, profileId)];
  const share = businessShare.amountMinor;
  // The cap (SHARE_CAP_BPS = 50%): staff always keep at least half.
  if (share <= 0n || share * 2n > net)
    throw new RangeError('share out of range');
  return [
    line('recipient_payable', 'credit', net - share, profileId),
    line(
      'business_payable',
      'credit',
      share,
      undefined,
      businessShare.businessId,
    ),
  ];
}

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
    ...payableLines(input),
  ].filter((entry) => entry.amountMinor > 0n);
}

/**
 * Business release 2: a refund or chargeback takes back what a payment owed: every credit line of
 * it (the person's part, the business's part, TipMe's fee and the provider fee it recovered from the
 * tip), as debits, in proportion to the refund. The partner's refund guide says "Fees already
 * charged are not returned", so the provider fee expense is never taken back: TipMe absorbs it, and
 * the partner balance (`provider_clearing`) drops by the whole refund. A fee the refund itself
 * carries (`refundFeeMinor`) is TipMe's expense too, out of the same balance. Nobody's balance loses
 * more than the payment gave them.
 *
 * `lines` is what is left to take back of the payment (all of it the first time); only its credit
 * lines are used. A refund of everything left mirrors them exactly. Less is scaled down and rounded
 * down, then the remainder kobo goes first on the person's line (the first `recipient_payable`),
 * then on the others in order, never beyond a line, so the debits total exactly the refund.
 */
export function buildReversalPosting(
  lines: readonly LedgerLine[],
  refund: { refundedMinor: bigint; refundFeeMinor?: bigint },
): LedgerLine[] {
  const { refundedMinor } = refund;
  const refundFeeMinor = refund.refundFeeMinor ?? 0n;
  if (!isBalanced(lines) || lines.some((l) => l.amountMinor <= 0n))
    throw new RangeError('only a balanced posting can be reversed');
  const owed = lines.filter((l) => l.side === 'credit');
  const left = owed.reduce((total, l) => total + l.amountMinor, 0n);
  if (refundedMinor <= 0n || refundedMinor > left)
    throw new RangeError('refund out of range');
  if (refundFeeMinor < 0n) throw new RangeError('refund fee out of range');
  const back = owed.map((l) => ({
    ...l,
    side: 'debit' as const,
    amountMinor: (l.amountMinor * refundedMinor) / left,
  }));
  const person = back.findIndex((l) => l.account === 'recipient_payable');
  const order = [
    ...(person >= 0 ? [person] : []),
    ...back.flatMap((_, i) => (i === person ? [] : [i])),
  ];
  let remainder =
    refundedMinor - back.reduce((total, l) => total + l.amountMinor, 0n);
  for (const i of order) {
    if (remainder === 0n) break;
    const room = owed[i]!.amountMinor - back[i]!.amountMinor;
    const take = remainder < room ? remainder : room;
    back[i]!.amountMinor += take;
    remainder -= take;
  }
  return [
    ...back.filter((l) => l.amountMinor > 0n),
    ...(refundFeeMinor > 0n
      ? [line('provider_fee_expense', 'debit', refundFeeMinor)]
      : []),
    line('provider_clearing', 'credit', refundedMinor + refundFeeMinor),
  ];
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

/** The provider's fee on a payout is TipMe's cost, paid from its balance: never the recipient's. */
export function buildPayoutFeePosting({
  feeMinor,
}: {
  feeMinor: bigint;
}): LedgerLine[] {
  if (feeMinor <= 0n) throw new RangeError('payout fee must be positive');
  return [
    line('provider_fee_expense', 'debit', feeMinor),
    line('provider_clearing', 'credit', feeMinor),
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
