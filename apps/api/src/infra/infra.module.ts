import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import pg from 'pg';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from './database.js';

export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

export function createPgPool(url: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 1000,
  });
  // Idle-client errors are reported through readiness, not by crashing the process.
  pool.on('error', () => undefined);
  return pool;
}

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
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.pool.end().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createPgPool(config.DATABASE_URL),
    },
    {
      provide: REDIS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createRedis(config.REDIS_URL),
    },
    InfraLifecycle,
    DatabaseProvider,
  ],
  exports: [PG_POOL, REDIS, DatabaseProvider],
})
export class InfraModule {}
