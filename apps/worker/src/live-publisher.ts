import type { Counter } from '@opentelemetry/api';
import type { LiveMessage } from '@tipme/contracts';
import type { Logger } from '@tipme/observability';
import type { Redis } from 'ioredis';

/**
 * Publishes live signals over the worker's fail-fast client (no offline queue). Never throws, and
 * never fails or retries the work that raised the signals: a lost one is caught by the page's next
 * resync, safety refresh or poll.
 */
export function createWorkerLivePublisher(deps: {
  redis: Pick<Redis, 'publish'>;
  channel: string;
  logger: Pick<Logger, 'warn'>;
  counter: Pick<Counter, 'add'>;
}): (messages: LiveMessage[]) => Promise<void> {
  return async (messages) => {
    for (const message of messages) {
      try {
        await deps.redis.publish(
          deps.channel,
          JSON.stringify({ to: message.to, type: message.type }),
        );
        deps.counter.add(1, { type: message.type, outcome: 'ok' });
      } catch (error) {
        // The error's name only: no ids.
        deps.logger.warn({
          event: 'live.publish_failed',
          type: message.type,
          error: error instanceof Error ? error.name : 'unknown',
        });
        deps.counter.add(1, { type: message.type, outcome: 'failed' });
      }
    }
  };
}
