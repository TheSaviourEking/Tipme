import type { PaymentMode } from './payment-mode';

// The pilot notice: one quiet line where money moves, while TipMe is a closed pilot with real
// payments. The words are the owner's; they name no payment provider.
export const PILOT_NOTICE_TEXT =
  'TipMe is in a pilot. Payments are real. Need help?';
export const PILOT_NOTICE_SUPPORT_EMAIL = 'support@usetipme.xyz';

/** Off unless `PILOT_NOTICE` is exactly "on". */
export function pilotNoticeOn(
  env: Record<string, string | undefined>,
): boolean {
  return env['PILOT_NOTICE'] === 'on';
}

/**
 * "Payments are real" is true only in live mode: never on a test copy, and not while a live
 * copy is still closed. So the setting alone never shows the notice.
 */
export function pilotNoticeShown(
  env: Record<string, string | undefined>,
  mode: PaymentMode,
): boolean {
  return pilotNoticeOn(env) && mode === 'live';
}
