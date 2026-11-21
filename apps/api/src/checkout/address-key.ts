import { createHmac } from 'node:crypto';
import { rateLimitSubject } from './rate-limit.guard.js';

/**
 * You collect (ruling P34): the supporter's address as stored on an intent, so one address can hold
 * only a few unfinished intents on a collect page. It is the rate-limit subject (an IPv4 address, or
 * an IPv6 /64), keyed with a server secret under its own label, so the address itself is never
 * stored and can't be recovered by hashing every IPv4 address. Undefined when the address is
 * unknown: one shared key would let anyone's checkouts limit everyone's.
 */
export function intentAddressKey(
  secret: string,
  ip: string | undefined,
): string | undefined {
  const subject = rateLimitSubject(ip);
  if (subject === 'unknown') return undefined;
  return createHmac('sha256', secret)
    .update(`tip-intent-address:${subject}`)
    .digest('base64url');
}
