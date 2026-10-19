import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
} from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';

/** The API's Postgres handle for PR-005 operations; closed on shutdown. */
@Injectable()
export class DatabaseProvider implements OnApplicationShutdown {
  private readonly handle: DatabaseHandle;
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.handle = createDatabase(config.DATABASE_URL, { max: 5 });
  }
  get db(): Database {
    return this.handle.db;
  }
  async onApplicationShutdown(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}
