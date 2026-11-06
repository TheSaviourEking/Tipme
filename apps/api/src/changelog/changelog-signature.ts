import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a signed request's timestamp may be from now, either way. */
export const CHANGELOG_SIGNATURE_WINDOW_SECONDS = 300;

const TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/**
 * True only for `sha256=<hex>` of HMAC-SHA256(secret, `${timestamp}.${raw}`), with a timestamp
 * (unix seconds) within 300 s of `now` (milliseconds). An empty or missing secret never passes.
 * The compare is constant time over equal-length digests.
 */
export function changelogSignatureValid(input: {
  secret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  raw: Buffer;
  now: number;
}): boolean {
  const { secret, timestamp, signature } = input;
  if (!secret || !timestamp || !signature) return false;
  if (!TIMESTAMP.test(timestamp)) return false;
  if (
    Math.abs(input.now / 1000 - Number(timestamp)) >
    CHANGELOG_SIGNATURE_WINDOW_SECONDS
  )
    return false;
  const hex = SIGNATURE.exec(signature)?.[1];
  if (!hex) return false;
  const given = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(input.raw)
    .digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
