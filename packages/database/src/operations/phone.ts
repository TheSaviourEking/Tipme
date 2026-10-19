import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * A phone number in E.164 form (`+2348031234567`), or null if it is not a possible number.
 * Local formats ("0803 123 4567") are read in the default region, Nigeria while D-01 is open.
 */
export function normalisePhone(
  input: string,
  defaultRegion: 'NG' = 'NG',
): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultRegion);
  return parsed?.isValid() ? parsed.number : null;
}

/** The last four digits, for "sent to •••4567" style hints. Never the whole number. */
export const phoneHint = (e164: string): string => `•••${e164.slice(-4)}`;
