import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A receipt token is HMAC-SHA256(secret, tipId) in base64url: nothing is stored, and an
 * idempotent replay of the same tip naturally returns the same token.
 */
export function createStatusToken(secret: string, tipId: string): string {
  return createHmac('sha256', secret).update(tipId).digest('base64url');
}

export function verifyStatusToken(
  secret: string,
  tipId: string,
  token: string,
): boolean {
  const expected = Buffer.from(createStatusToken(secret, tipId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
