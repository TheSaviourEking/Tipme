import type { MailProviderEvent, MailProviderName } from '@tipme/mail';
import { and, count, eq, gte, notInArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  mailMessageEvents,
  mailMessages,
  mailSuppressions,
} from '../schema.js';
import {
  addressHmac,
  recordMailEvent,
  type MailSealing,
} from './mail-queue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOFT_BOUNCES_TO_SUPPRESS = 3;
const SOFT_BOUNCE_WINDOW_MS = 7 * 86_400_000;

/**
 * Applies one verified provider event: it lands on its email (by our reference, else the
 * provider's message id) and, for bounces and complaints, keeps TipMe from emailing the address
 * again. Events from a provider that is no longer active still count. A repeat changes nothing.
 */
export function applyMailProviderEvent(
  db: Database,
  sealing: MailSealing,
  provider: MailProviderName,
  event: MailProviderEvent,
  now: Date,
): Promise<'recorded' | 'duplicate' | 'unmatched'> {
  return db.transaction(async (tx) => {
    const byReference =
      event.reference && UUID.test(event.reference)
        ? eq(mailMessages.id, event.reference)
        : null;
    const byProviderId = event.providerMessageId
      ? and(
          eq(mailMessages.provider, provider),
          eq(mailMessages.providerMessageId, event.providerMessageId),
        )
      : null;
    const [message] =
      byReference || byProviderId
        ? await tx
            .select({
              id: mailMessages.id,
              type: mailMessages.type,
              category: mailMessages.category,
            })
            .from(mailMessages)
            .where(byReference ?? byProviderId!)
            .limit(1)
        : [];
    const bounce =
      event.kind === 'hard_bounce' ||
      event.kind === 'soft_bounce' ||
      event.kind === 'complaint';
    const hmac =
      bounce && event.address ? addressHmac(sealing, event.address) : null;
    const recorded = await recordMailEvent(tx, {
      messageId: message?.id ?? null,
      kind: event.kind,
      provider,
      providerEventId: event.providerEventId,
      linkKey: event.linkKey,
      addressHmac: hmac,
      occurredAt: event.occurredAt,
      ...(message ? { type: message.type, category: message.category } : {}),
    });
    if (!recorded) return 'duplicate';

    const suppress = async (
      reason: 'hard_bounce' | 'complaint' | 'repeated_soft_bounce',
    ) => {
      if (!hmac) return;
      await tx
        .insert(mailSuppressions)
        .values({ addressHmac: hmac, reason, provider, createdAt: now })
        .onConflictDoNothing();
    };
    if (event.kind === 'hard_bounce' || event.kind === 'complaint') {
      await suppress(event.kind);
      if (message)
        await tx
          .update(mailMessages)
          .set({
            status: event.kind === 'complaint' ? 'complained' : 'bounced',
          })
          // A complaint is never downgraded to a bounce.
          .where(
            and(
              eq(mailMessages.id, message.id),
              notInArray(mailMessages.status, ['complained']),
            ),
          );
    }
    if (event.kind === 'soft_bounce' && hmac) {
      const [recent] = await tx
        .select({ n: count() })
        .from(mailMessageEvents)
        .where(
          and(
            eq(mailMessageEvents.addressHmac, hmac),
            eq(mailMessageEvents.kind, 'soft_bounce'),
            gte(
              mailMessageEvents.occurredAt,
              new Date(now.getTime() - SOFT_BOUNCE_WINDOW_MS),
            ),
          ),
        );
      if ((recent?.n ?? 0) >= SOFT_BOUNCES_TO_SUPPRESS)
        await suppress('repeated_soft_bounce');
    }
    return message ? 'recorded' : 'unmatched';
  });
}
