import type { OpsPaymentReserve } from '@tipme/contracts';

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
  /** What the last reading says; a stale reading keeps its own state. */
  status: 'ok' | 'low' | 'unreadable' | 'none';
  /** The checks may have stopped (the API decides: it is older than 45 minutes). */
  stale: boolean;
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
      stale: false,
    };
  // An older API sends no flag: then nothing is called stale.
  const stale = reserve.stale === true;
  const level = `Alert below ${nairaSign(reserve.thresholdMinor)}`;
  const read = `read ${ago(now - Date.parse(reserve.readAt))}`;
  return {
    value:
      reserve.availableMinor === null
        ? 'Can’t be read'
        : nairaSign(reserve.availableMinor),
    hint: stale
      ? `${level} · ${read}: the checks may have stopped`
      : `${level} · ${read}`,
    status: reserve.low === null ? 'unreadable' : reserve.low ? 'low' : 'ok',
    stale,
  };
}
