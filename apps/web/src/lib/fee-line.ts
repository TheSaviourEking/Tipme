// The one fee line on a recipient's tip detail (PR-012): what came off the tip, and what it was.
// Tips priced before PR-012 keep their recorded amounts, so the label follows the amounts.
const ZERO = BigInt(0);
/** Basis points as a plain percentage: 500 → "5%", 750 → "7.5%". */
const percent = (bps: number) => {
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${Math.floor(bps / 100)}${frac ? `.${frac}` : ''}%`;
};
const BPS = BigInt(10000);

/**
 * Whether a tip was priced under a policy where processing is paid from TipMe's share: any of
 * `versions` (PROCESSING_INCLUDED_FEE_VERSIONS: the old 10% V1, and V2 Free 7% / Pro 5%, owner 12 Nov 2026).
 * Passing only the newest version would relabel every older 10% tip as the pre-PR-012 rule.
 * The quote writer records a version alone or with its own suffixes ("-custom-750",
 * "-fee-free"); a version that only begins with the same characters ("proposed-v1.10") is not it.
 */
export function followsCurrentRule(
  recorded: string,
  versions: readonly string[],
) {
  return versions.some(
    (version) => recorded === version || recorded.startsWith(`${version}-`),
  );
}
/**
 * With the tip's gross, the label names the share this tip really paid ("7%" on Free, "5%" on Pro, an older tip's "10%", or whatever a
 * staff-set share was), read from the amounts the API reports; never a hard-coded rate.
 */
export function feeLine(
  platformFeeMinor: string,
  providerFeeMinor: string,
  grossMinor?: string,
  /**
   * Whether the tip was priced under a rule where processing is paid from TipMe's share
   * (followsCurrentRule with PROCESSING_INCLUDED_FEE_VERSIONS). Older tips had processing
   * on top, so "includes processing" and a single share would be untrue for them.
   */
  currentRule = true,
): { label: string; minor: string } {
  const platform = BigInt(platformFeeMinor);
  const provider = BigInt(providerFeeMinor);
  if (platform === ZERO && provider === ZERO)
    return { label: 'TipMe fee (waived)', minor: '0' };
  if (platform === ZERO)
    return {
      label: 'Payment processing (TipMe’s fee waived)',
      minor: String(provider),
    };
  if (!currentRule)
    return {
      label: 'TipMe fee and payment processing',
      minor: String(platform + provider),
    };
  const gross = grossMinor ? BigInt(grossMinor) : ZERO;
  const total = platform + provider;
  // Nearest basis point, in integers only.
  const share =
    gross > ZERO
      ? percent(Number((total * BPS * BigInt(2) + gross) / (gross * BigInt(2))))
      : null;
  return {
    label: share
      ? `TipMe fee (${share}, includes processing)`
      : 'TipMe fee (includes processing)',
    minor: String(total),
  };
}
