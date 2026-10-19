import { formatDemoAmount } from './demo-amount';

/** NGN amounts from the API's decimal strings of minor units. */
export const naira = (minor: string | number) =>
  formatDemoAmount(Number(minor));

/** "▲ 25%", "▼ 8%", "New" (nothing before) or "—" (nothing either time). Never a comparison with others. */
export function change(
  current: string,
  previous: string,
): { text: string; tone: 'up' | 'down' | 'flat' } {
  const now = Number(current);
  const before = Number(previous);
  if (now === 0 && before === 0) return { text: '—', tone: 'flat' };
  if (before === 0) return { text: 'New', tone: 'up' };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: '0%', tone: 'flat' };
  return pct > 0
    ? { text: `▲ ${pct}%`, tone: 'up' }
    : { text: `▼ ${Math.abs(pct)}%`, tone: 'down' };
}

/** Naira typed by a person ("1000", "1,000.50") as minor units, or null. No upper demo cap. */
export function parseNaira(value: string): number | null {
  const match = /^(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const minor =
    Number((match[1] ?? '').replaceAll(',', '')) * 100 +
    Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
