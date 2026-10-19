/** UI samples only; these limits are not a live tipping or fee policy. */
export function parseDemoAmount(value: string): number | null {
  // Plain digits, or digits with correctly grouped thousands separators (1,500).
  const match = /^(\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const whole = (match[1] ?? '').replaceAll(',', '');
  const fraction = match[2] ?? '';
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor >= 100 && minor <= 10000000
    ? minor
    : null;
}
export function formatDemoAmount(minor: number): string {
  const digits = String(minor).padStart(3, '0');
  return `NGN ${new Intl.NumberFormat('en').format(Number(digits.slice(0, -2)))}.${digits.slice(-2)}`;
}
