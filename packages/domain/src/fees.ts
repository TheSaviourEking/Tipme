/**
 * MOCK fee policy — NOT an approved commercial policy (docs/00-DECISIONS.md D-05).
 * Per the user's description, TipMe's cut and the provider fee are deducted from the tip:
 * the payer pays the tip amount and the recipient receives the net.
 */
export const MOCK_FEE_POLICY_V0 = {
  version: 'mock-v0',
  platformFeeBps: 500n,
  providerFeeBps: 150n,
  minTipMinor: 100n,
  maxTipMinor: 10_000_000n,
} as const;

export type FeePolicy = typeof MOCK_FEE_POLICY_V0;

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
 * Prices a tip. `feeFree` waives only TipMe's own fee; the provider's fee always applies, and
 * the recipient receives the difference.
 */
export function priceTip(
  tipMinor: bigint,
  policy: FeePolicy = MOCK_FEE_POLICY_V0,
  options: { feeFree?: boolean } = {},
): FeeBreakdown {
  if (tipMinor < policy.minTipMinor || tipMinor > policy.maxTipMinor) {
    throw new AmountOutOfRangeError('tip outside the allowed range');
  }
  const platformFeeMinor = options.feeFree
    ? 0n
    : bpsOf(tipMinor, policy.platformFeeBps);
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
