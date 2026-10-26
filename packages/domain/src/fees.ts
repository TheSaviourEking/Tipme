/**
 * Retired mock policy (5% TipMe fee plus 1.5% provider fee, both from the recipient). Kept so
 * quotes made under it still explain themselves; new quotes use FEE_POLICY.
 */
export const MOCK_FEE_POLICY_V0 = {
  version: 'mock-v0',
  platformFeeBps: 500n,
  providerFeeBps: 150n,
  minTipMinor: 100n,
  maxTipMinor: 10_000_000n,
} as const;

export interface FeePolicy {
  version: string;
  platformFeeBps: bigint;
  /** The provider fee recovered from the recipient; under v1 TipMe pays it from its own fee. */
  providerFeeBps: bigint;
  minTipMinor: bigint;
  maxTipMinor: bigint;
}

/**
 * The product owner's policy (ADR-0014): TipMe takes a flat 10% of each tip and pays the
 * payment provider out of it, so the recipient always receives 90%. Still pretend money.
 */
export const FEE_POLICY: FeePolicy = {
  version: 'v1',
  platformFeeBps: 1000n,
  providerFeeBps: 0n,
  minTipMinor: 100n,
  maxTipMinor: 10_000_000n,
};

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

/** The version recorded on a quote whose TipMe fee was waived (a staff-granted fee-free tip). */
export const FEE_FREE_VERSION_SUFFIX = '-fee-free';

/**
 * Prices a tip. `platformFeeBps` is a staff-set fee for one account (it replaces the policy's
 * fee); `feeFree` waives TipMe's fee entirely. Any provider fee recovered from the recipient
 * still applies, and the recipient receives the difference.
 */
export function priceTip(
  tipMinor: bigint,
  policy: FeePolicy = FEE_POLICY,
  options: { feeFree?: boolean; platformFeeBps?: bigint } = {},
): FeeBreakdown {
  if (tipMinor < policy.minTipMinor || tipMinor > policy.maxTipMinor) {
    throw new AmountOutOfRangeError('tip outside the allowed range');
  }
  const feeBps = options.platformFeeBps ?? policy.platformFeeBps;
  if (feeBps < 0n || feeBps > 10000n)
    throw new RangeError('fee must be between 0 and 100%');
  const platformFeeMinor = options.feeFree ? 0n : bpsOf(tipMinor, feeBps);
  const providerFeeMinor = bpsOf(tipMinor, policy.providerFeeBps);
  const recipientNetMinor = tipMinor - platformFeeMinor - providerFeeMinor;
  if (recipientNetMinor <= 0n)
    throw new AmountOutOfRangeError('tip too small after fees');
  return {
    tipMinor,
    platformFeeMinor,
    providerFeeMinor,
    payerTotalMinor: tipMinor,
    recipientNetMinor,
  };
}
