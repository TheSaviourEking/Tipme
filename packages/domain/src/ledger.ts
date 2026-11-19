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
  | 'business_payable'
  // Paid Pro (ADR-0015; ADR-0006 addendum, needs finance sign-off): what recipients paid TipMe for
  // Pro, and TipMe's OWN partner balance, kept apart from provider_clearing (tips).
  | 'subscription_revenue'
  | 'platform_clearing'
  // You collect (ADR-0016): what TipMe holds on its own partner account for recipients until it is
  // transferred on. Owned by a person (`profileId`) or, for a business share, a business.
  | 'held_for_recipients'
  | 'dispute_fee_expense'
  | 'dispute_loss_expense'
  | 'refund_loss_expense';

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

/**
 * A refund (owner, 14 Nov 2026): TipMe keeps its fee, and the supporter gets back the tip minus it.
 * So a refund takes back only what the payment owed the person and the business (`owed`: what is
 * left of its credit lines), in proportion and each never beyond its own part, and never TipMe's fee
 * or the processing it recovered. The partner balance drops by what is taken back (plus a fee the
 * refund itself carries, TipMe's expense). A refund for more than they have left to give (a full
 * refund made at the partner) takes all of it; the rest is `excessMinor`, reported for staff and
 * never charged to anyone here. A chargeback is not a refund: it uses `buildReversalPosting`.
 */
export function buildRefundReversalPosting(
  owed: readonly LedgerLine[],
  refund: { refundedMinor: bigint; refundFeeMinor?: bigint },
): { lines: LedgerLine[]; excessMinor: bigint } {
  if (refund.refundedMinor <= 0n) throw new RangeError('refund out of range');
  const theirs = owed.filter(
    (l) =>
      l.side === 'credit' &&
      l.amountMinor > 0n &&
      (l.account === 'recipient_payable' || l.account === 'business_payable'),
  );
  const left = theirs.reduce((sum, l) => sum + l.amountMinor, 0n);
  if (left === 0n)
    throw new RangeError('nothing the person or business received is left');
  const taken = refund.refundedMinor < left ? refund.refundedMinor : left;
  const lines = buildReversalPosting(
    [line('provider_clearing', 'debit', left), ...theirs],
    {
      refundedMinor: taken,
      ...(refund.refundFeeMinor !== undefined
        ? { refundFeeMinor: refund.refundFeeMinor }
        : {}),
    },
  );
  return { lines, excessMinor: refund.refundedMinor - taken };
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

/**
 * The provider's fee on a payout as TipMe's cost, paid from its balance: payouts requested before
 * 12 Nov 2026's rule, and any part of a fee above what the user was charged (TipMe absorbs it).
 */
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

/**
 * The partner's payout fee when the user pays it (owner, 12 Nov 2026): taken from what the person
 * or business chose to withdraw, so it comes off their own payable, like the payout itself. Payouts
 * requested before that rule keep TipMe paying (buildPayoutFeePosting).
 */
export function buildUserPayoutFeePosting({
  feeMinor,
  profileId,
  businessId,
}: {
  feeMinor: bigint;
  profileId?: string;
  businessId?: string;
}): LedgerLine[] {
  if (feeMinor <= 0n) throw new RangeError('payout fee must be positive');
  if (Boolean(profileId) === Boolean(businessId))
    throw new RangeError('a payout belongs to exactly one person or business');
  return [
    businessId
      ? line('business_payable', 'debit', feeMinor, undefined, businessId)
      : line('recipient_payable', 'debit', feeMinor, profileId),
    line('provider_clearing', 'credit', feeMinor),
  ];
}

/**
 * The part of a user-paid payout fee the partner did not charge (owner, 14 Nov 2026): taken from the
 * amount but still in the account, so it is credited back to the same payable.
 */
export function buildUserPayoutFeeRefundPosting({
  feeMinor,
  profileId,
  businessId,
}: {
  feeMinor: bigint;
  profileId?: string;
  businessId?: string;
}): LedgerLine[] {
  if (feeMinor <= 0n) throw new RangeError('payout fee must be positive');
  if (Boolean(profileId) === Boolean(businessId))
    throw new RangeError('a payout belongs to exactly one person or business');
  return [
    businessId
      ? line('business_payable', 'credit', feeMinor, undefined, businessId)
      : line('recipient_payable', 'credit', feeMinor, profileId),
    line('provider_clearing', 'debit', feeMinor),
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

/**
 * Paid Pro bought by checkout on TipMe's own account (ADR-0015). The partner keeps its fee from the
 * gross; the fee is always the read-back's. Not a tip: no TipMe fee, no recipient payable.
 */
export function buildProCheckoutPosting(input: {
  grossMinor: bigint;
  feeMinor: bigint;
}): LedgerLine[] {
  const { grossMinor, feeMinor } = input;
  if (grossMinor <= 0n) throw new RangeError('a Pro sale has a positive price');
  if (feeMinor < 0n || feeMinor > grossMinor)
    throw new RangeError('provider fee out of range');
  return [
    line('platform_clearing', 'debit', grossMinor - feeMinor),
    line('provider_fee_expense', 'debit', feeMinor),
    line('subscription_revenue', 'credit', grossMinor),
  ].filter((entry) => entry.amountMinor > 0n);
}

/**
 * Paid Pro from the TipMe balance (plan Task 8; ADR-0006 addendum, needs finance sign-off), posted
 * only after the partner moved the money from the person's account to TipMe's own. What TipMe owed
 * the person pays for Pro (`recipient_payable` down, `subscription_revenue` up), and the money moves
 * from the connected accounts' balance (`provider_clearing`) to TipMe's own (`platform_clearing`).
 * No fee: an account-to-platform transfer carries none.
 */
export function buildProBalancePosting(input: {
  amountMinor: bigint;
  profileId: string;
}): LedgerLine[] {
  const { amountMinor, profileId } = input;
  if (amountMinor <= 0n)
    throw new RangeError('a Pro sale has a positive price');
  if (!profileId) throw new RangeError('a balance payment names its person');
  return [
    line('recipient_payable', 'debit', amountMinor, profileId),
    line('subscription_revenue', 'credit', amountMinor),
    line('platform_clearing', 'debit', amountMinor),
    line('provider_clearing', 'credit', amountMinor),
  ];
}

/**
 * Business Pro from the business balance (plan Task A2; ruling R9). Needs finance sign-off, like
 * its sibling `buildProBalancePosting` (ADR-0006 addendum). Posted only after the partner moved the
 * money from the business's own connected account to TipMe's: what TipMe owed the business pays for
 * the month (`business_payable` down, as a business withdrawal takes it), and the money moves from
 * the connected accounts' balance (`provider_clearing`) to TipMe's own (`platform_clearing`).
 */
export function buildBusinessProBalancePosting(input: {
  amountMinor: bigint;
  businessId: string;
}): LedgerLine[] {
  const { amountMinor, businessId } = input;
  if (amountMinor <= 0n)
    throw new RangeError('a Business Pro sale has a positive price');
  if (!businessId)
    throw new RangeError('a business balance payment names its business');
  return [
    line('business_payable', 'debit', amountMinor, undefined, businessId),
    line('subscription_revenue', 'credit', amountMinor),
    line('platform_clearing', 'debit', amountMinor),
    line('provider_clearing', 'credit', amountMinor),
  ];
}

/**
 * A card-paid Pro month refunded by the partner (`refund.paid`; plan Task 9, ruling 6): Pro revenue
 * gives back what was refunded, out of TipMe's own balance. The original card fee is not returned by
 * the partner and stays TipMe's expense; a fee the refund itself carries is TipMe's too.
 */
export function buildProRefundPosting(input: {
  refundedMinor: bigint;
  refundFeeMinor: bigint;
  /** What the sale booked: a refund never takes back more. */
  grossMinor: bigint;
}): LedgerLine[] {
  const { refundedMinor, refundFeeMinor, grossMinor } = input;
  if (refundedMinor <= 0n || refundedMinor > grossMinor)
    throw new RangeError('refund out of range');
  if (refundFeeMinor < 0n) throw new RangeError('refund fee out of range');
  return [
    line('subscription_revenue', 'debit', refundedMinor),
    line('provider_fee_expense', 'debit', refundFeeMinor),
    line('platform_clearing', 'credit', refundedMinor + refundFeeMinor),
  ].filter((entry) => entry.amountMinor > 0n);
}

// ---------------------------------------------------------------------------------------------
// You collect (ADR-0016; codes illustrative pending finance sign-off, ADR-0006). TipMe collects each
// tip on its own partner account (`platform_clearing`) and holds every recipient's share
// (`held_for_recipients`) until it is transferred on. The recipient's payable is unchanged.
// ---------------------------------------------------------------------------------------------

/** Who a held amount belongs to: a person, or (a share, ruling R3) a business. */
export type Owner = { profileId: string } | { businessId: string };

function ownerOf(owner: Owner): { profileId?: string; businessId?: string } {
  const { profileId, businessId } = owner as {
    profileId?: string;
    businessId?: string;
  };
  if (Boolean(profileId) === Boolean(businessId))
    throw new RangeError(
      'a held amount belongs to exactly one person or business',
    );
  return profileId ? { profileId } : { businessId: businessId! };
}

const heldLine = (
  side: LedgerLine['side'],
  amountMinor: bigint,
  owner: Owner,
) => {
  const { profileId, businessId } = ownerOf(owner);
  return line('held_for_recipients', side, amountMinor, profileId, businessId);
};

const payableOf = (amountMinor: bigint, owner: Owner): LedgerLine => {
  const { profileId, businessId } = ownerOf(owner);
  return businessId
    ? line('business_payable', 'debit', amountMinor, undefined, businessId)
    : line('recipient_payable', 'debit', amountMinor, profileId);
};

function requirePositive(amountMinor: bigint, what: string): void {
  if (amountMinor <= 0n) throw new RangeError(`${what} must be positive`);
}

/**
 * A tip collected on TipMe's own account. The partner pays the gross to TipMe less its actual fee;
 * what TipMe owes goes into `held_for_recipients` (the person: net less any share; the business:
 * the share), and the payables are credited exactly as `buildPaymentPosting` does. TipMe's own line
 * on `platform_clearing` is `platformFee + quotedFee - actualFee`: a debit normally, a credit when
 * the actual fee is above the quote (an international card). A team tip is refused: team splits are
 * not collected this way.
 */
export function buildCollectPaymentPosting(
  input: PaymentPostingInput,
): LedgerLine[] {
  if (input.teamSplits)
    throw new RangeError('a collect tip carries no team split');
  const {
    grossMinor,
    platformFeeMinor,
    quotedProviderFeeMinor,
    actualProviderFeeMinor,
    recipientNetMinor,
    profileId,
    businessShare,
  } = input;
  if (
    grossMinor !==
    platformFeeMinor + quotedProviderFeeMinor + recipientNetMinor
  )
    throw new RangeError('fee breakdown does not add up to the gross amount');
  if (platformFeeMinor < 0n || quotedProviderFeeMinor < 0n)
    throw new RangeError('fees cannot be negative');
  if (actualProviderFeeMinor < 0n || actualProviderFeeMinor > grossMinor)
    throw new RangeError('provider fee out of range');
  // payableLines validates the person, the share and its cap.
  const payables = payableLines(input);
  // The person (and the business) are checked by heldLine, which refuses a missing or empty id.
  const share = businessShare?.amountMinor ?? 0n;
  const own =
    platformFeeMinor + quotedProviderFeeMinor - actualProviderFeeMinor;
  return [
    heldLine('debit', recipientNetMinor - share, { profileId: profileId! }),
    ...(businessShare
      ? [
          heldLine('debit', share, {
            businessId: businessShare.businessId,
          }),
        ]
      : []),
    line(
      'platform_clearing',
      own < 0n ? 'credit' : 'debit',
      own < 0n ? -own : own,
    ),
    line('provider_fee_expense', 'debit', actualProviderFeeMinor),
    line('platform_fee_revenue', 'credit', platformFeeMinor),
    line('provider_fee_recovered', 'credit', quotedProviderFeeMinor),
    ...payables,
  ].filter((entry) => entry.amountMinor > 0n);
}

/** TipMe transfers a held amount to its owner's account: no payable moves. */
export function buildCollectTransferPosting(
  input: { amountMinor: bigint } & Owner,
): LedgerLine[] {
  requirePositive(input.amountMinor, 'a transfer');
  return [
    line('provider_clearing', 'debit', input.amountMinor),
    heldLine('credit', input.amountMinor, input),
  ];
}

/** A transferred amount comes back to TipMe's account: the mirror of the transfer. */
export function buildCollectReturnPosting(
  input: { amountMinor: bigint } & Owner,
): LedgerLine[] {
  requirePositive(input.amountMinor, 'a return');
  return [
    heldLine('debit', input.amountMinor, input),
    line('provider_clearing', 'credit', input.amountMinor),
  ];
}

/**
 * A refund of money still held: each part takes back the owner's payable and the held money, never
 * TipMe's fee. A fee the refund itself carries is TipMe's expense, out of its own balance.
 */
export function buildCollectRefundPosting(input: {
  parts: readonly ({ amountMinor: bigint } & Owner)[];
  refundFeeMinor?: bigint;
}): LedgerLine[] {
  const fee = input.refundFeeMinor ?? 0n;
  if (input.parts.length === 0) throw new RangeError('a refund has a part');
  if (fee < 0n) throw new RangeError('refund fee out of range');
  const lines: LedgerLine[] = [];
  for (const part of input.parts) {
    requirePositive(part.amountMinor, 'a refund part');
    lines.push(
      payableOf(part.amountMinor, part),
      heldLine('credit', part.amountMinor, part),
    );
  }
  if (fee > 0n)
    lines.push(
      line('provider_fee_expense', 'debit', fee),
      line('platform_clearing', 'credit', fee),
    );
  return lines;
}

/**
 * A refund TipMe pays from its own money (the recipient already withdrew, so nothing is held to take
 * back). The refund is the loss; a fee it carries is the partner's fee, booked as for any refund.
 */
export function buildAbsorbedRefundPosting(input: {
  amountMinor: bigint;
  refundFeeMinor?: bigint;
}): LedgerLine[] {
  const fee = input.refundFeeMinor ?? 0n;
  requirePositive(input.amountMinor, 'a refund');
  if (fee < 0n) throw new RangeError('refund fee out of range');
  const total = input.amountMinor + fee;
  return [
    line('refund_loss_expense', 'debit', input.amountMinor),
    ...(fee > 0n ? [line('provider_fee_expense', 'debit', fee)] : []),
    line('platform_clearing', 'credit', total),
  ];
}

/** The partner's fee for a dispute, TipMe's own cost. */
export function buildDisputeFeePosting(input: {
  feeMinor: bigint;
}): LedgerLine[] {
  requirePositive(input.feeMinor, 'a dispute fee');
  return [
    line('dispute_fee_expense', 'debit', input.feeMinor),
    line('platform_clearing', 'credit', input.feeMinor),
  ];
}

/**
 * A lost dispute: the partner takes the disputed amount from TipMe's account. What was still held
 * is taken back from the owners (payable and held, as a refund does); TipMe absorbs the rest.
 * TipMe's fee revenue is not reversed (ruling R6).
 */
export function buildDisputeLossPosting(input: {
  disputedMinor: bigint;
  recovered: readonly ({ amountMinor: bigint } & Owner)[];
}): LedgerLine[] {
  requirePositive(input.disputedMinor, 'a disputed amount');
  let recovered = 0n;
  const lines: LedgerLine[] = [];
  for (const part of input.recovered) {
    requirePositive(part.amountMinor, 'a recovered part');
    recovered += part.amountMinor;
    lines.push(
      payableOf(part.amountMinor, part),
      heldLine('credit', part.amountMinor, part),
    );
  }
  if (recovered > input.disputedMinor)
    throw new RangeError('recovered more than the disputed amount');
  const loss = input.disputedMinor - recovered;
  if (loss > 0n)
    lines.push(
      line('dispute_loss_expense', 'debit', loss),
      line('platform_clearing', 'credit', loss),
    );
  return lines;
}
