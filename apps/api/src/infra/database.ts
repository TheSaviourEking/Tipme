import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  adaptPoolToServer,
  createDatabase,
  type AdaptiveBudget,
  type Database,
  type DatabaseHandle,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { LOGGER } from '../tokens.js';

/** The API's one Postgres pool, readiness included; closed on shutdown. */
@Injectable()
export class DatabaseProvider implements OnModuleInit, OnApplicationShutdown {
  private readonly handle: DatabaseHandle;
  readonly budget: AdaptiveBudget;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.handle = createDatabase(config.DATABASE_URL, {
      connectionTimeoutMillis: config.DATABASE_POOL_CONNECT_TIMEOUT_MS,
    });
    this.budget = adaptPoolToServer(this.handle, {
      role: 'api',
      override: config.DATABASE_POOL_MAX,
      refreshMs: config.DATABASE_BUDGET_REFRESH_MS,
      counts: {
        apiProcesses: config.DATABASE_BUDGET_API_PROCESSES,
        workerProcesses: config.DATABASE_BUDGET_WORKER_PROCESSES,
        margin: config.DATABASE_BUDGET_MARGIN,
      },
      log: (level, entry) => logger[level](entry),
    });
  }
  /** Boots on the small fallback if the read fails or is slow: never refuses to start. */
  onModuleInit(): Promise<void> {
    return this.budget.ready;
  }
  get db(): Database {
    return this.handle.db;
  }
  get pool(): DatabaseHandle['pool'] {
    return this.handle.pool;
  }
  async onApplicationShutdown(): Promise<void> {
    this.budget.stop();
    await this.handle.close().catch(() => undefined);
  }
}
