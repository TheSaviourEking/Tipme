/**
 * A staff-typed fee percentage ("10", "7.5", "0") as basis points, by integer parsing only (no
 * floating point for money); null when it is not a percentage from 0 to 100 with ≤ 2 decimals.
 */
export function percentToBps(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(
    raw.trim().replace(/%$/, ''),
  );
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}

/** Basis points as staff read them: 1000 → "10%", 750 → "7.5%". */
export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}
