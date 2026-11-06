import type { LiveMessage } from '@tipme/contracts';
import type { Logger } from '@tipme/observability';
import type { Redis } from 'ioredis';

export const LIVE_PUBLISHER = Symbol('LIVE_PUBLISHER');

/** Resolves always: a publish never fails or retries the work that raised it. */
export type PublishLive = (message: LiveMessage) => Promise<void>;

/**
 * Over the API's fail-fast REDIS client (no offline queue), so while Redis is down a publish fails at
 * once instead of piling up. Call it only after the write it describes has committed, and never await
 * it inside a database transaction.
 */
export function createLivePublisher(deps: {
  redis: Pick<Redis, 'publish'>;
  channel: string;
  logger: Logger;
  counter: (type: string, outcome: 'ok' | 'failed') => void;
}): PublishLive {
  return async (message) => {
    try {
      await deps.redis.publish(
        deps.channel,
        JSON.stringify({ to: message.to, type: message.type }),
      );
      deps.counter(message.type, 'ok');
    } catch (error) {
      // The error's name only: no ids, and no message that could carry one.
      deps.logger.warn({
        event: 'live.publish_failed',
        type: message.type,
        error: error instanceof Error ? error.name : 'unknown',
      });
      deps.counter(message.type, 'failed');
    }
  };
}
