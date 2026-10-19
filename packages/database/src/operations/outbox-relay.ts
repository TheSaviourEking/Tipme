import type { TraceCarrier } from '@tipme/contracts';
import { asc, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { outboxEvents } from '../schema.js';
import type { OutboxPayload } from './outbox.js';

export interface OutboxRow {
  id: string;
  eventType: string;
  dedupeKey: string;
  payload: OutboxPayload;
  trace: TraceCarrier;
}

/**
 * Claims up to `limit` unpublished rows (SKIP LOCKED, so concurrent relays split the work),
 * publishes each, then marks them published, all in one transaction. If publishing fails, nothing
 * is marked and the rows are retried later: delivery is at least once, and consumers dedupe by
 * `dedupeKey`. `attempts` counts failed publish attempts.
 */
export async function relayOutboxOnce(
  db: Database,
  publish: (row: OutboxRow) => Promise<void>,
  limit = 50,
): Promise<number> {
  let claimed: string[] = [];
  try {
    return await claimAndPublish(db, publish, limit, (ids) => (claimed = ids));
  } catch (error) {
    // The transaction rolled back; record the failed attempt so stuck events are visible.
    if (claimed.length > 0) {
      await db
        .update(outboxEvents)
        .set({ attempts: sql`${outboxEvents.attempts} + 1` })
        .where(inArray(outboxEvents.id, claimed))
        .catch(() => undefined);
    }
    throw error;
  }
}

function claimAndPublish(
  db: Database,
  publish: (row: OutboxRow) => Promise<void>,
  limit: number,
  onClaim: (ids: string[]) => void,
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: outboxEvents.id,
        eventType: outboxEvents.eventType,
        dedupeKey: outboxEvents.dedupeKey,
        payload: outboxEvents.payload,
        trace: outboxEvents.trace,
      })
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    onClaim(rows.map((row) => row.id));
    for (const row of rows) {
      await publish({
        ...row,
        payload: row.payload as OutboxPayload,
        trace: row.trace as TraceCarrier,
      });
    }
    if (rows.length > 0) {
      await tx
        .update(outboxEvents)
        .set({ publishedAt: sql`now()` })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((row) => row.id),
          ),
        );
    }
    return rows.length;
  });
}
