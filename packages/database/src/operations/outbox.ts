import { injectTraceCarrier } from '@tipme/observability';
import type { Tx } from '../client.js';
import { outboxEvents } from '../schema.js';
import { newId } from './ids.js';

/** String-only payloads: amounts travel as decimal strings, so bigint can never reach JSON. */
export type OutboxPayload = Record<string, string | null>;

/**
 * Returns true when a new row was written (false when deduped).
 * Written in the same transaction as the state change it announces. The dedupe key uses `.`
 * because BullMQ job IDs (which reuse it) may not contain `:`. Payloads hold IDs and amounts only.
 */
export async function enqueueOutbox(
  tx: Tx,
  event: {
    eventType: string;
    aggregateId: string;
    payload: OutboxPayload;
    /** Alerts pass the triggering event's ID so every occurrence is kept, not just the first. */
    dedupeSuffix?: string;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(outboxEvents)
    .values({
      id: newId(),
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      dedupeKey: [event.eventType, event.aggregateId, event.dedupeSuffix]
        .filter(Boolean)
        .join('.'),
      payload: event.payload,
      trace: injectTraceCarrier(),
    })
    .onConflictDoNothing()
    .returning({ id: outboxEvents.id });
  return inserted.length > 0;
}
