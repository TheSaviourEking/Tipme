// The pilot notice: a quiet line in the footer while TipMe is a closed pilot with real payments.
// The words are the owner's; they name no payment provider.
export const PILOT_NOTICE_TEXT =
  'TipMe is in a pilot. Payments are real. Need help?';
export const PILOT_NOTICE_SUPPORT_EMAIL = 'support@usetipme.xyz';

/** Off unless `PILOT_NOTICE` is exactly "on". */
export function pilotNoticeOn(
  env: Record<string, string | undefined>,
): boolean {
  return env['PILOT_NOTICE'] === 'on';
}
