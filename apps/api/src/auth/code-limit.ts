import { isPretendRecipient } from '@tipme/mail';

/** The most codes an hour the settings allow (RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR's maximum). */
const LIFTED = 100;

/**
 * Sign-in codes an address may get per hour. On a test copy, an address that can never receive
 * mail (the release check's staff, .example sign-ups) gets the lifted limit: its codes only reach
 * the pretend inbox, and the release check signs it in on every deploy. Everyone else, and every
 * address on a live copy, keeps the normal limit.
 */
export function codesPerHourFor(
  email: string,
  input: {
    releaseKind: 'test' | 'live';
    pretendDomains: readonly string[];
    normal: number;
  },
): number {
  return input.releaseKind === 'test' &&
    isPretendRecipient(email, input.pretendDomains)
    ? LIFTED
    : input.normal;
}
