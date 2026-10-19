import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-mock-signature';
const TOLERANCE_SECONDS = 300;

const hmac = (
  secret: string,
  timestamp: number,
  rawBody: Buffer | string,
): Buffer =>
  createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, the common provider pattern. */
export function signWebhook(
  rawBody: string,
  secret: string,
  now: Date,
): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},v1=${hmac(secret, timestamp, rawBody).toString('hex')}`;
}

/** Verifies the exact bytes received, in constant time, within ±300 s. */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  now: Date,
): 'ok' | 'missing_signature' | 'bad_signature' | 'stale' {
  if (!header) return 'missing_signature';
  const parts = new Map(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [
        part.slice(0, index).trim(),
        part.slice(index + 1).trim(),
      ] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1') ?? '';
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]+$/.test(signature))
    return 'bad_signature';
  if (Math.abs(now.getTime() / 1000 - timestamp) > TOLERANCE_SECONDS)
    return 'stale';
  const expected = hmac(secret, timestamp, rawBody);
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length &&
    timingSafeEqual(received, expected)
    ? 'ok'
    : 'bad_signature';
}
