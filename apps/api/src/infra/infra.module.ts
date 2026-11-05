import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from './database.js';
import {
  PARTNER_QUOTE_CACHE,
  RedisPartnerQuoteCache,
} from './partner-quote-cache.js';

export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

/** Fails commands immediately while disconnected instead of queueing them (no offline queue). */
export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  redis.on('error', () => undefined);
  redis.connect().catch(() => undefined);
  return redis;
}

class InfraLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      // The same pool as every request: a second pool would be connections the budget can't spare.
      inject: [DatabaseProvider],
      useFactory: (database: DatabaseProvider) => database.pool,
    },
    {
      provide: REDIS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createRedis(config.REDIS_URL),
    },
    {
      provide: PARTNER_QUOTE_CACHE,
      inject: [API_CONFIG, REDIS],
      useFactory: (config: ApiConfig, redis: Redis) =>
        new RedisPartnerQuoteCache(redis, {
          prefix: config.QUEUE_PREFIX,
          seconds: config.PARTNER_QUOTE_CACHE_SECONDS,
          // A quote waits this long at most for Redis before asking the provider itself.
          timeoutMs: 200,
        }),
    },
    InfraLifecycle,
    DatabaseProvider,
  ],
  exports: [PG_POOL, REDIS, PARTNER_QUOTE_CACHE, DatabaseProvider],
})
export class InfraModule {}
