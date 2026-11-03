// The one fee line on a recipient's tip detail (PR-012): what came off the tip, and what it was.
// Tips priced before PR-012 keep their recorded amounts, so the label follows the amounts.
const ZERO = BigInt(0);
/** Basis points as a plain percentage: 1000 → "10%", 750 → "7.5%". */
const percent = (bps: number) => {
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${Math.floor(bps / 100)}${frac ? `.${frac}` : ''}%`;
};
const BPS = BigInt(10000);

/**
 * Whether a tip was priced under the current fee policy, where processing is paid from TipMe's
 * share. The quote writer records the policy's version, alone or with its own suffixes
 * ("-custom-750", "-fee-free"); a later version that only begins with the same characters
 * ("proposed-v1.10") is not this one.
 */
export function followsCurrentRule(recorded: string, current: string) {
  return recorded === current || recorded.startsWith(`${current}-`);
}
/**
 * With the tip's gross, the label names the share this tip really paid ("10%", or whatever a
 * staff-set share was), read from the amounts the API reports; never a hard-coded rate.
 */
export function feeLine(
  platformFeeMinor: string,
  providerFeeMinor: string,
  grossMinor?: string,
  /**
   * Whether the tip was priced under the current rule (its feePolicyVersion starts with
   * FEE_POLICY_V1.version): processing is paid from TipMe's share. Older tips had processing
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
