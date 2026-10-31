import type { MailEventKind, MailProviderEvent } from '../provider.js';

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function linkKey(link: string | null): string | null {
  if (!link) return null;
  try {
    return new URL(link).searchParams.get('ml');
  } catch {
    return null;
  }
}

/**
 * Normalised events from one SES event notification (configuration-set events). Send, reject
 * and delay notices are ignored: TipMe records sends itself.
 */
export function sesEvents(
  message: string,
  snsMessageId: string,
  now: Date,
): MailProviderEvent[] | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = obj(JSON.parse(message));
  } catch {
    return null;
  }
  const type = str(parsed['eventType']) ?? str(parsed['notificationType']);
  const mail = obj(parsed['mail']);
  const reference = str(
    (obj(mail['tags'])['ref'] as unknown[] | undefined)?.[0],
  );
  const providerMessageId = str(mail['messageId']);
  const destination = Array.isArray(mail['destination'])
    ? str(mail['destination'][0])
    : null;
  const at = (value: unknown) => {
    const text = str(value);
    return text && !Number.isNaN(Date.parse(text)) ? new Date(text) : now;
  };
  const make = (
    kind: MailEventKind,
    index: number,
    address: string | null,
    occurredAt: Date,
    key: string | null = null,
  ): MailProviderEvent => ({
    kind,
    providerEventId: `${snsMessageId}:${index}`,
    occurredAt,
    address,
    providerMessageId,
    reference,
    linkKey: key,
  });
  if (type === 'Bounce') {
    const bounce = obj(parsed['bounce']);
    const kind: MailEventKind =
      bounce['bounceType'] === 'Permanent' ? 'hard_bounce' : 'soft_bounce';
    const recipients = Array.isArray(bounce['bouncedRecipients'])
      ? bounce['bouncedRecipients']
      : [];
    return recipients.map((r, i) =>
      make(kind, i, str(obj(r)['emailAddress']), at(bounce['timestamp'])),
    );
  }
  if (type === 'Complaint') {
    const complaint = obj(parsed['complaint']);
    const recipients = Array.isArray(complaint['complainedRecipients'])
      ? complaint['complainedRecipients']
      : [];
    return recipients.map((r, i) =>
      make(
        'complaint',
        i,
        str(obj(r)['emailAddress']),
        at(complaint['timestamp']),
      ),
    );
  }
  if (type === 'Delivery')
    return [
      make(
        'delivered',
        0,
        destination,
        at(obj(parsed['delivery'])['timestamp']),
      ),
    ];
  if (type === 'Open')
    return [
      make('opened', 0, destination, at(obj(parsed['open'])['timestamp'])),
    ];
  if (type === 'Click') {
    const click = obj(parsed['click']);
    return [
      make(
        'clicked',
        0,
        destination,
        at(click['timestamp']),
        linkKey(str(click['link'])),
      ),
    ];
  }
  return [];
}
