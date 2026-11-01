import type { OpsPaymentReserve } from '@tipme/contracts';

/** The worker reads the reserve every 15 minutes: three missed reads is a stopped check. */
const STALE_AFTER_MS = 45 * 60_000;

/** ₦1,800 or ₦1,800.50 from minor units as text. (Local so this file loads in plain Node tests.) */
function nairaSign(minor: string): string {
  const digits = minor.padStart(3, '0');
  const kobo = digits.slice(-2);
  const whole = new Intl.NumberFormat('en').format(BigInt(digits.slice(0, -2)));
  return kobo === '00' ? `₦${whole}` : `₦${whole}.${kobo}`;
}

export interface ReserveView {
  value: string;
  hint: string;
  status: 'ok' | 'low' | 'unreadable' | 'stale' | 'none';
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 90
    ? `${minutes} min ago`
    : `${Math.round(minutes / 60)} h ago`;
}

/** The Overview's reserve tile, from the latest reading (staff only; the public route has no amounts). */
export function reserveView(
  reserve: OpsPaymentReserve | null | undefined,
  now: number,
): ReserveView {
  if (!reserve)
    return {
      value: 'Not read yet',
      hint: 'The worker checks every 15 minutes once a payment provider is running.',
      status: 'none',
    };
  const age = now - Date.parse(reserve.readAt);
  const level = `Alert below ${nairaSign(reserve.thresholdMinor)}`;
  const read = `read ${ago(age)}`;
  const value =
    reserve.availableMinor === null
      ? 'Can’t be read'
      : nairaSign(reserve.availableMinor);
  if (age > STALE_AFTER_MS)
    return {
      value,
      hint: `${level} · ${read}: the checks may have stopped`,
      status: 'stale',
    };
  return {
    value,
    hint: `${level} · ${read}`,
    status: reserve.low === null ? 'unreadable' : reserve.low ? 'low' : 'ok',
  };
}
