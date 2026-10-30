import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  MailEventKind,
  MailProviderEvent,
  MailWebhookResult,
  WebhookHeaders,
} from '../provider.js';

const STALE_AFTER_MS = 5 * 60_000;

const KINDS: Record<string, MailEventKind> = {
  hardbounce: 'hard_bounce',
  softbounce: 'soft_bounce',
  fbl_complaint: 'complaint',
  email_open: 'opened',
  email_link_click: 'clicked',
};

const header = (headers: WebhookHeaders, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

/** `producer-signature: ts=<ms>;s=<url-encoded base64>;s-algorithm=HmacSHA256` */
function parseSignature(raw: string | undefined) {
  if (!raw) return null;
  const parts = new Map<string, string>();
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) parts.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const ts = Number(parts.get('ts'));
  const s = parts.get('s');
  const algorithm = parts.get('s-algorithm');
  if (!Number.isFinite(ts) || !s || !algorithm) return null;
  return { ts, s, algorithm };
}

/**
 * The signed text is the URL-decoded value of the body's single form parameter. ZeptoMail's
 * sample decodes it as a form ("+" is a space) while its note warns about a literal "+", and
 * nothing published settles which it sends, so both readings are tried. Either way a match
 * proves the sender holds the key, and the matching text is the one that gets parsed.
 */
function signedPayloads(rawBody: Buffer): string[] {
  const raw = rawBody.toString('utf8');
  const at = raw.indexOf('=');
  if (at < 0) return [];
  const value = raw.slice(at + 1);
  try {
    const asForm = decodeURIComponent(value.replace(/\+/g, ' '));
    const literal = decodeURIComponent(value);
    return asForm === literal ? [asForm] : [asForm, literal];
  } catch {
    return [];
  }
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function linkKeyOf(details: Record<string, unknown>): string | null {
  const url =
    str(details['clicked_link']) ?? str(details['link']) ?? str(details['url']);
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('ml');
  } catch {
    return null;
  }
}

/** Normalised events from a verified ZeptoMail webhook; unknown event kinds are ignored. */
function eventsOf(
  payload: unknown,
  now: Date,
  fallbackId: string,
): MailProviderEvent[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  const webhookId = str(body['webhook_request_id']) ?? fallbackId;
  const names = Array.isArray(body['event_name']) ? body['event_name'] : [];
  const messages = Array.isArray(body['event_message'])
    ? body['event_message']
    : null;
  if (!messages) return null;
  const events: MailProviderEvent[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const m = message as Record<string, unknown>;
    const info = (m['email_info'] ?? {}) as Record<string, unknown>;
    const data = Array.isArray(m['event_data']) ? m['event_data'] : [];
    const first = (data[0] ?? {}) as Record<string, unknown>;
    const kindName = str(first['object']) ?? str(names[index] ?? names[0]);
    const kind = kindName ? KINDS[kindName] : undefined;
    if (!kind) return;
    const details = (
      Array.isArray(first['details']) ? (first['details'][0] ?? {}) : {}
    ) as Record<string, unknown>;
    const to = Array.isArray(info['to']) ? info['to'][0] : undefined;
    const address =
      to && typeof to === 'object'
        ? str(
            (
              (to as Record<string, unknown>)['email_address'] as
                Record<string, unknown> | undefined
            )?.['address'],
          )
        : null;
    const time = str(details['time']) ?? str(details['modified_time']);
    const occurredAt =
      time && !Number.isNaN(Date.parse(time)) ? new Date(time) : now;
    events.push({
      kind,
      providerEventId: `${webhookId}:${index}`,
      occurredAt,
      address,
      providerMessageId: str(m['request_id']),
      reference: str(info['client_reference']),
      linkKey: kind === 'clicked' ? linkKeyOf(details) : null,
    });
  });
  return events;
}

export function verifyZeptoWebhook(
  rawBody: Buffer,
  headers: WebhookHeaders,
  key: string,
  now: Date,
): MailWebhookResult {
  const signature = parseSignature(header(headers, 'producer-signature'));
  // The header names its algorithm; anything else is refused, never passed to crypto.
  if (!signature || signature.algorithm !== 'HmacSHA256')
    return { ok: false, reason: 'signature' };
  const payloads = signedPayloads(rawBody);
  if (payloads.length === 0) return { ok: false, reason: 'malformed' };
  let received: Buffer;
  try {
    received = Buffer.from(decodeURIComponent(signature.s), 'base64');
  } catch {
    return { ok: false, reason: 'signature' };
  }
  const payload = payloads.find((candidate) => {
    const expected = createHmac('sha256', key)
      .update(candidate, 'utf8')
      .digest();
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  });
  if (payload === undefined) return { ok: false, reason: 'signature' };
  if (Math.abs(now.getTime() - signature.ts) > STALE_AFTER_MS)
    return { ok: false, reason: 'stale' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // No webhook id: the signed text itself identifies this delivery, so distinct events stay
  // distinct and a redelivery still dedupes.
  const fallbackId = createHash('sha256')
    .update(payload)
    .digest('hex')
    .slice(0, 32);
  const events = eventsOf(parsed, now, fallbackId);
  return events ? { ok: true, events } : { ok: false, reason: 'malformed' };
}
