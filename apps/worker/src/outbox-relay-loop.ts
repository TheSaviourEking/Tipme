import type { LiveMessage } from '@tipme/contracts';
import { relayOutboxOnce, type Database } from '@tipme/database';
import type { Logger } from '@tipme/observability';
import type { Queue } from 'bullmq';
import { databaseFailureFields, RELAY_JOB_RETRIES } from './job-retry.js';
import { liveSignalFor } from './live-signals.js';

const RETENTION_SECONDS = 7 * 24 * 60 * 60;

export interface OutboxRelay {
  stop(): Promise<void>;
}

/**
 * Moves committed outbox rows onto the job queue. The dedupe key becomes the BullMQ job ID, so a
 * row published twice (crash between publish and mark) still produces one job. While Redis or
 * Postgres is unavailable it backs off exponentially; rows wait safely in Postgres.
 */
export function startOutboxRelay(options: {
  db: Database;
  queue: Pick<Queue, 'add'>;
  logger: Pick<Logger, 'warn'>;
  intervalMs?: number;
  maxBackoffMs?: number;
  /** Live signals for the relayed rows; called only after the claim has committed. Never throws. */
  publishLive?: (messages: LiveMessage[]) => Promise<void>;
}): OutboxRelay {
  const {
    db,
    queue,
    logger,
    intervalMs = 1000,
    maxBackoffMs = 30_000,
  } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let delay = intervalMs;

  const tick = async (): Promise<void> => {
    // Collected inside the claim, published only once it has committed: a rolled-back claim
    // (a failed queue add) signals nothing, and no publish ever waits inside the transaction.
    const signals: LiveMessage[] = [];
    try {
      await relayOutboxOnce(db, async (row) => {
        await queue.add(
          row.eventType,
          { ...row.payload, _trace: row.trace },
          {
            jobId: row.dedupeKey,
            // Keep finished relay jobs for 7 days so a re-published row is deduped by job ID.
            removeOnComplete: { age: RETENTION_SECONDS },
            removeOnFail: { age: RETENTION_SECONDS },
            ...RELAY_JOB_RETRIES,
          },
        );
        signals.push(...liveSignalFor(row.eventType, row.payload));
      });
      delay = intervalMs;
      if (signals.length > 0 && options.publishLive)
        void options.publishLive(signals).catch(() => undefined);
    } catch (error) {
      logger.warn({
        event: 'outbox.relay_failed',
        error: error instanceof Error ? error.name : 'unknown',
        ...databaseFailureFields(error),
      });
      delay = Math.min(delay * 2, maxBackoffMs);
    }
    if (!stopped) timer = setTimeout(() => (running = tick()), delay);
  };
  running = tick();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
