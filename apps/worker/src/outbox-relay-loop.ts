import type { LiveMessage } from '@tipme/contracts';
import {
  relayOutboxOnce,
  withdrawalSignalDue,
  type Database,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import type { Queue } from 'bullmq';
import { databaseFailureFields, RELAY_JOB_RETRIES } from './job-retry.js';
import {
  liveSignalFor,
  requestGate,
  whenRequestMoved,
} from './live-signals.js';

const RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Finished relay jobs are kept for 7 days so a re-published row is deduped by job ID. Exported so
 * the scheduled-run retention test can check that the schedulers never cut this short.
 */
export const RELAY_JOB_RETENTION = {
  removeOnComplete: { age: RETENTION_SECONDS },
  removeOnFail: { age: RETENTION_SECONDS },
} as const;

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
    const signals: {
      messages: LiveMessage[];
      gate: ReturnType<typeof requestGate>;
    }[] = [];
    try {
      await relayOutboxOnce(db, async (row) => {
        await queue.add(
          row.eventType,
          { ...row.payload, _trace: row.trace },
          {
            jobId: row.dedupeKey,
            ...RELAY_JOB_RETENTION,
            ...RELAY_JOB_RETRIES,
          },
        );
        signals.push({
          messages: liveSignalFor(row.eventType, row.payload),
          gate: requestGate(row.eventType, null, row.payload),
        });
      });
      delay = intervalMs;
      const publish = options.publishLive;
      if (signals.length > 0 && publish)
        // A split request's paid part waits for its request (Task 9): asked after the commit, so
        // the check reads every part this claim relayed. Never awaited by the loop.
        void (async () => {
          const due = (input: Parameters<typeof withdrawalSignalDue>[1]) =>
            withdrawalSignalDue(db, input);
          const ready = await Promise.all(
            signals.map(({ messages, gate }) =>
              whenRequestMoved(messages, gate, due),
            ),
          );
          const messages = ready.flat();
          if (messages.length > 0) await publish(messages);
        })().catch(() => undefined);
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
