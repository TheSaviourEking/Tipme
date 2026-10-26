import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** True when the header is `Bearer <expected>` (constant time); never true without a token. */
export function bearerMatches(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
  return (
    Boolean(expected) && timingSafeEqual(digest(given), digest(expected ?? ''))
  );
}
