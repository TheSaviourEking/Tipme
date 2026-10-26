// The one fee line on a recipient's tip detail (PR-012): what came off the tip, and what it was.
// Tips priced before PR-012 keep their recorded amounts, so the label follows the amounts.
const ZERO = BigInt(0);
export function feeLine(
  platformFeeMinor: string,
  providerFeeMinor: string,
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
  return {
    label: 'TipMe fee (includes processing)',
    minor: String(platform + provider),
  };
}
