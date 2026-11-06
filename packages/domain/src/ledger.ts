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

const opposite = (side: LedgerLine['side']): LedgerLine['side'] =>
  side === 'debit' ? 'credit' : 'debit';

/**
 * Business release 2: a refund or chargeback takes back every line of a payment, the person's and
 * the business's parts alike, sides swapped. Without `fraction` it mirrors the lines exactly. With
 * one (a partial refund of `num` out of a gross of `den`), each line is scaled down and rounded
 * down; each side then takes the refund's remainder kobo, first on the person's line (the first
 * `recipient_payable`) on the side that holds it, else on the side's first line, never beyond an
 * original line. Each side totals floor(gross × num / den), so the reversal always balances, and
 * with `den` the gross it takes back exactly the refund.
 */
export function buildReversalPosting(
  original: readonly LedgerLine[],
  fraction?: { num: bigint; den: bigint },
): LedgerLine[] {
  if (!isBalanced(original) || original.some((l) => l.amountMinor <= 0n))
    throw new RangeError('only a balanced posting can be reversed');
  const mirrored = original.map((l) => ({ ...l, side: opposite(l.side) }));
  if (!fraction) return mirrored;
  const { num, den } = fraction;
  if (den <= 0n || num <= 0n || num > den)
    throw new RangeError('reversal fraction out of range');
  const gross = original
    .filter((l) => l.side === 'debit')
    .reduce((sum, l) => sum + l.amountMinor, 0n);
  const target = (gross * num) / den;
  if (target <= 0n) throw new RangeError('reversal rounds to nothing');
  const scaled = mirrored.map((l) => ({
    ...l,
    amountMinor: (l.amountMinor * num) / den,
  }));
  for (const side of ['debit', 'credit'] as const) {
    const indexes = scaled.flatMap((l, i) => (l.side === side ? [i] : []));
    const person = indexes.find(
      (i) => scaled[i]!.account === 'recipient_payable',
    );
    const order =
      person === undefined
        ? indexes
        : [person, ...indexes.filter((i) => i !== person)];
    let remainder =
      target - indexes.reduce((sum, i) => sum + scaled[i]!.amountMinor, 0n);
    for (const i of order) {
      if (remainder === 0n) break;
      const room = mirrored[i]!.amountMinor - scaled[i]!.amountMinor;
      const take = remainder < room ? remainder : room;
      scaled[i]!.amountMinor += take;
      remainder -= take;
    }
  }
  return scaled.filter((l) => l.amountMinor > 0n);
}

/** Paying a recipient settles what TipMe owed them out of the provider balance. */
export function buildPayoutPosting({
  amountMinor,
  profileId,
  businessId,
}: {
  amountMinor: bigint;
  /** A person's withdrawal takes their `recipient_payable`. */
  profileId?: string;
  /** A business's withdrawal (release 2, R2-B) takes its own `business_payable`, never a person's. */
  businessId?: string;
}): LedgerLine[] {
  if (amountMinor <= 0n) throw new RangeError('payout amount must be positive');
  if (Boolean(profileId) === Boolean(businessId))
    throw new RangeError('a payout belongs to exactly one person or business');
  return [
    businessId
      ? line('business_payable', 'debit', amountMinor, undefined, businessId)
      : line('recipient_payable', 'debit', amountMinor, profileId),
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
