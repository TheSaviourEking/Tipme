import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Staff authenticator codes (PR-009, ADR-0010): RFC 6238, HMAC-SHA1, 6 digits, 30-second steps.
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpAt(
  secretBase32: string,
  step: bigint,
  digits = DIGITS,
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(step);
  const mac = createHmac('sha1', base32Decode(secretBase32))
    .update(counter)
    .digest();
  const offset = mac[mac.length - 1]! & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Accepts the current step or one either side, but never a step at or before `lastStep`: a code
 * that was used once cannot be used again.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date,
  lastStep: bigint | null,
): { ok: true; step: bigint } | { ok: false } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const current = BigInt(Math.floor(now.getTime() / 1000 / STEP_SECONDS));
  for (const step of [current - 1n, current, current + 1n]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (
      timingSafeEqual(
        Buffer.from(totpAt(secretBase32, step)),
        Buffer.from(code),
      )
    )
      return { ok: true, step };
  }
  return { ok: false };
}

/** A new 160-bit secret in base32, as authenticator apps expect. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The enrolment link an authenticator app reads from a QR code. */
export function otpauthUrl(secret: string, account: string): string {
  const issuer = 'TipMe Admin';
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
