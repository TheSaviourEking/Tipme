/**
 * PRD v1.1's PROPOSED commercial rules (docs/00-DECISIONS.md D-05) — pretend money until approved.
 * TipMe keeps 10% of the tip and pays the processing fee out of that share, so the recipient
 * always receives 90%. Processing is an estimate here (150 bps, the mock provider's fee); the
 * provider's actual fee is booked when it reports it, and any difference is TipMe's.
 * Applies to every page; a Pro page may raise its own minimum (never lower it). There is no
 * maximum: supporters tip what they want (the API only bounds the input format, 12 digits).
 */
export const FEE_POLICY_V1 = {
  version: 'proposed-v1.1',
  tipmeShareBps: 1000n,
  providerFeeBps: 150n,
  minTipMinor: 100_000n,
  minWithdrawalMinor: 100_000n,
} as const;

export type FeePolicy = typeof FEE_POLICY_V1;

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
 */
export function priceTip(
  tipMinor: bigint,
  policy: FeePolicy = FEE_POLICY_V1,
  options: { feeFree?: boolean; minTipMinor?: bigint } = {},
): FeeBreakdown {
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
  const shareMinor = bpsOf(tipMinor, policy.tipmeShareBps);
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

/** The amounts every Free page shows (PR-012): ₦1,000, ₦2,000 and ₦5,000. */
export const STANDARD_TIP_PRESETS_MINOR = [
  100_000n,
  200_000n,
  500_000n,
] as const;

/**
 * Which field of a Pro page's own amounts is not allowed, or null when they are: 1 to 4 unique
 * presets in whole naira, each at least the page's minimum, and a minimum in whole naira that is
 * never below the policy's. There is no maximum.
 */
export function tipAmountsProblem(
  presetsMinor: readonly bigint[],
  minTipMinor: bigint,
  policy: FeePolicy = FEE_POLICY_V1,
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
