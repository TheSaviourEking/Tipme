import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { unmatchedProviderEvents } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

/** Keeps a verified provider message that matches nothing we know, so none is ever lost. */
export function recordUnmatchedEvent(
  db: Database,
  input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: unknown;
    reason: 'unknown_attempt' | 'unknown_payout';
  },
): Promise<'stored' | 'duplicate' | 'conflict'> {
  return guarded(async () => {
    const payload = input.payload ?? {};
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    const inserted = await db
      .insert(unmatchedProviderEvents)
      .values({
        id: newId(),
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payloadHash,
        payload,
        reason: input.reason,
      })
      .onConflictDoNothing()
      .returning({ id: unmatchedProviderEvents.id });
    if (inserted.length > 0) return 'stored';
    // Same ID seen before: a duplicate only if the content is identical.
    const [original] = await db
      .select({
        eventType: unmatchedProviderEvents.eventType,
        payloadHash: unmatchedProviderEvents.payloadHash,
      })
      .from(unmatchedProviderEvents)
      .where(
        and(
          eq(unmatchedProviderEvents.provider, input.provider),
          eq(unmatchedProviderEvents.providerEventId, input.providerEventId),
        ),
      );
    return original &&
      original.eventType === input.eventType &&
      original.payloadHash === payloadHash
      ? 'duplicate'
      : 'conflict';
  });
}
