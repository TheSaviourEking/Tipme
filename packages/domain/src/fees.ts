/** A fee policy: what TipMe keeps of a tip and the minimums. Quotes record its `version`. */
export interface FeePolicy {
  readonly version: string;
  /** TipMe's share of the tip, processing included. */
  readonly tipmeShareBps: bigint;
  /** The estimated processing fee, paid out of TipMe's share. */
  readonly providerFeeBps: bigint;
  /** The smallest tip, and since 14 Nov 2026 the smallest withdrawal too (withdrawalMinimumMinor). */
  readonly minTipMinor: bigint;
}

/**
 * PRD v1.1's commercial rules (docs/00-DECISIONS.md D-05), in force until 12 Nov 2026: TipMe kept
 * 10% of the tip and paid the processing fee out of that share, so the recipient received 90%.
 * Processing is an estimate here (150 bps, the mock provider's fee); the provider's actual fee is
 * booked when it reports it, and any difference is TipMe's. Kept for history: tips priced under it
 * keep their recorded amounts, and nothing reprices them.
 * Applies to every page; a Pro page may raise its own minimum (never lower it). There is no
 * maximum: supporters tip what they want (the API only bounds the input format, 12 digits).
 */
export const FEE_POLICY_V1: FeePolicy = {
  version: 'proposed-v1.1',
  tipmeShareBps: 1000n,
  providerFeeBps: 150n,
  minTipMinor: 200_000n,
};

/**
 * The owner's pricing, 12 Nov 2026 (docs/00-DECISIONS.md D-05 addendum): the recipient's plan at
 * quote time picks TipMe's share, processing still included. TipMe Free keeps 7% of each tip with no
 * subscription; TipMe Pro (₦5,000 a month) keeps 5%. For quotes created from the release that
 * carries it: a quote already shown (15-minute life) is charged as shown, and tips before keep
 * their recorded 10%. The version names the plan's rate, so a recorded tip says what it paid.
 * Minimums are unchanged.
 */
export const FEE_POLICY_V2_FREE: FeePolicy = {
  version: 'v2-free-7pct',
  tipmeShareBps: 700n,
  providerFeeBps: 150n,
  minTipMinor: 200_000n,
};

export const FEE_POLICY_V2_PRO: FeePolicy = {
  version: 'v2-pro-5pct',
  tipmeShareBps: 500n,
  providerFeeBps: 150n,
  minTipMinor: 200_000n,
};

/** The plan a page is on (`profiles.plan`, derived from staff grants and paid Pro months). */
export type FeePlan = 'free' | 'pro';

/** The policy a new quote uses, by the recipient's plan at quote time. */
export function feePolicyForPlan(plan: FeePlan): FeePolicy {
  return plan === 'pro' ? FEE_POLICY_V2_PRO : FEE_POLICY_V2_FREE;
}

/**
 * The standard policy (Free's), for the minimums every page shares and for copy that states the
 * standard rate. A quote never uses it blindly: it uses feePolicyForPlan.
 */
export const CURRENT_FEE_POLICY: FeePolicy = FEE_POLICY_V2_FREE;

/**
 * The share a quote uses: the plan's rate, or a staff-set share (ADR-0014) when it is below that
 * rate. A deal at or above the plan's rate is capped there and the quote records no deal
 * (`custom: null`), so a page never pays more than its plan says (owner, 12 Nov 2026).
 */
export function planShareBps(
  plan: FeePlan,
  customBps: bigint | null,
): { bps: bigint; custom: bigint | null } {
  const planBps = feePolicyForPlan(plan).tipmeShareBps;
  if (customBps === null || customBps >= planBps)
    return { bps: planBps, custom: null };
  return { bps: customBps, custom: customBps };
}

/**
 * Every policy under which processing is paid from TipMe's share (one fee line, "includes
 * processing"). A tip whose recorded version is one of these, alone or with the quote writer's
 * suffixes ("-custom-600", "-fee-free"), is labelled that way; older ones are not.
 */
export const PROCESSING_INCLUDED_FEE_VERSIONS: readonly string[] = [
  FEE_POLICY_V1.version,
  FEE_POLICY_V2_FREE.version,
  FEE_POLICY_V2_PRO.version,
];

export interface FeeBreakdown {
  tipMinor: bigint;
  platformFeeMinor: bigint;
  providerFeeMinor: bigint;
  payerTotalMinor: bigint;
  recipientNetMinor: bigint;
}

export class AmountOutOfRangeError extends Error {
  override readonly name = 'AmountOutOfRangeError';
}

/** Basis-point fee, rounded half up to the minor unit, in integer arithmetic. */
const bpsOf = (amount: bigint, bps: bigint): bigint =>
  (amount * bps + 5000n) / 10000n;

/** The version recorded on a quote whose TipMe fee was waived (a fee-free reward, PR-008). */
export const FEE_FREE_VERSION_SUFFIX = '-fee-free';

/**
 * Prices a tip. TipMe's share (processing included) comes off the tip and the recipient receives
 * the rest. `feeFree` waives TipMe's whole share: the recipient receives the full tip and TipMe
 * pays the processing itself. `minTipMinor` is a page's own minimum; it can only raise the floor.
 * `shareBps` is a share staff set for one account (ADR-0014), used instead of the policy's.
 */
export function priceTip(
  tipMinor: bigint,
  policy: FeePolicy = CURRENT_FEE_POLICY,
  options: { feeFree?: boolean; minTipMinor?: bigint; shareBps?: bigint } = {},
): FeeBreakdown {
  const shareBps = options.shareBps ?? policy.tipmeShareBps;
  if (shareBps < 0n || shareBps > 10000n)
    throw new RangeError('share must be between 0 and 10000 basis points');
  const floor =
    options.minTipMinor !== undefined &&
    options.minTipMinor > policy.minTipMinor
      ? options.minTipMinor
      : policy.minTipMinor;
  if (tipMinor < floor) {
    throw new AmountOutOfRangeError('tip outside the allowed range');
  }
  if (options.feeFree)
    return {
      tipMinor,
      platformFeeMinor: 0n,
      providerFeeMinor: 0n,
      payerTotalMinor: tipMinor,
      recipientNetMinor: tipMinor,
    };
  const shareMinor = bpsOf(tipMinor, shareBps);
  const estimatedProcessing = bpsOf(tipMinor, policy.providerFeeBps);
  // Processing is paid from TipMe's share and can never take more than it.
  const providerFeeMinor =
    estimatedProcessing < shareMinor ? estimatedProcessing : shareMinor;
  return {
    tipMinor,
    platformFeeMinor: shareMinor - providerFeeMinor,
    providerFeeMinor,
    payerTotalMinor: tipMinor,
    recipientNetMinor: tipMinor - shareMinor,
  };
}

/** The amounts every Free page shows: ₦2,000, ₦5,000 and ₦10,000. */
export const STANDARD_TIP_PRESETS_MINOR = [
  200_000n,
  500_000n,
  1_000_000n,
] as const;

/**
 * Which field of a Pro page's own amounts is not allowed, or null when they are: 1 to 4 unique
 * presets in whole naira, each at least the page's minimum, and a minimum in whole naira that is
 * never below the policy's. There is no maximum.
 */
export function tipAmountsProblem(
  presetsMinor: readonly bigint[],
  minTipMinor: bigint,
  policy: FeePolicy = CURRENT_FEE_POLICY,
): 'presetsMinor' | 'minMinor' | null {
  const wholeNaira = (amount: bigint) => amount % 100n === 0n;
  if (minTipMinor < policy.minTipMinor || !wholeNaira(minTipMinor))
    return 'minMinor';
  if (
    presetsMinor.length < 1 ||
    presetsMinor.length > 4 ||
    new Set(presetsMinor).size !== presetsMinor.length ||
    presetsMinor.some((amount) => amount < minTipMinor || !wholeNaira(amount))
  )
    return 'presetsMinor';
  return null;
}

/**
 * True when a Pro page's chosen starting amount is one of its own presets ("Make it yours").
 * It only picks which key the tip form starts on: nothing about fees or the minimum changes.
 */
export function tipStartAllowed(
  presetsMinor: readonly bigint[],
  startMinor: bigint,
): boolean {
  return presetsMinor.includes(startMinor);
}

/**
 * A withdrawal whose partner fee the user pays (owner, 12 Nov 2026): the fee is taken from the
 * amount chosen, so withdrawing ₦10,000 sends ₦9,950 and ₦10,000 leaves the balance. Null when
 * nothing would arrive: a balance of ₦50 or less can't be withdrawn.
 */
export function userPaidWithdrawal(input: {
  chosenMinor: bigint;
  feeMinor: bigint;
}): { sendMinor: bigint; feeMinor: bigint; leavesBalanceMinor: bigint } | null {
  if (input.feeMinor < 0n) throw new RangeError('fee must not be negative');
  const sendMinor = input.chosenMinor - input.feeMinor;
  if (sendMinor <= 0n) return null;
  return {
    sendMinor,
    feeMinor: input.feeMinor,
    leavesBalanceMinor: input.chosenMinor,
  };
}

/**
 * The smallest withdrawal (owner, 14 Nov 2026): the system's smallest tip, read from the policy so
 * the two can never drift. The partner's ₦50 fee still comes off the amount (userPaidWithdrawal).
 */
export function withdrawalMinimumMinor(
  policy: FeePolicy = CURRENT_FEE_POLICY,
): bigint {
  return policy.minTipMinor;
}

/**
 * Whether an amount is under the smallest withdrawal and is not everything that can go now: the
 * whole of it is always allowed, so nobody is left with money they can't take out (a balance of ₦50
 * or less is refused by the fee rule instead). The server and the screens share this rule.
 */
export function belowWithdrawalMinimum(
  chosenMinor: bigint,
  withdrawableMinor: bigint,
  policy: FeePolicy = CURRENT_FEE_POLICY,
): boolean {
  return (
    chosenMinor < withdrawalMinimumMinor(policy) &&
    chosenMinor !== withdrawableMinor
  );
}
