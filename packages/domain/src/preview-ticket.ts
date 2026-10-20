import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Staging/preview access (PR-010): one signed ticket opens both the web and API hosts. The format
// matches scripts/preview/gateway.mjs, so either gate accepts the same ticket.
export const PREVIEW_TICKET_TTL_MS = 12 * 3600_000;

const sign = (value: string, password: string) =>
  createHmac('sha256', password)
    .update(`tipme-preview:${value}`)
    .digest('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function issuePreviewTicket(password: string, now = Date.now()): string {
  const expires = String(now + PREVIEW_TICKET_TTL_MS);
  return `${expires}.${sign(expires, password)}`;
}

export function validPreviewTicket(
  ticket: string | undefined | null,
  password: string,
  now = Date.now(),
): boolean {
  if (typeof ticket !== 'string' || ticket.length > 100) return false;
  const [expires = '', mac = ''] = ticket.split('.');
  if (!/^\d{13}$/.test(expires)) return false;
  const at = Number(expires);
  return (
    at > now &&
    at <= now + PREVIEW_TICKET_TTL_MS &&
    same(mac, sign(expires, password))
  );
}

/** Server-to-server calls (web server → API, API → web) carry this instead of a browser ticket. */
export function previewServerKey(password: string): string {
  return createHmac('sha256', password)
    .update('tipme-preview-server')
    .digest('base64url');
}

export const previewKeyMatches = (key: string | undefined, password: string) =>
  typeof key === 'string' && same(key, previewServerKey(password));
