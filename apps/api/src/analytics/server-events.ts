import { Inject, Injectable } from '@nestjs/common';
import type { AnalyticsServerEvent } from '@tipme/contracts';
import { recordServerEvent } from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';

/**
 * Server-side analytics events the API itself knows about (PR-013, PRD v1.1 §11): a page created
 * or first published, a withdrawal requested. Off unless collection is on (D-07), once per
 * dedupe key, and never allowed to fail the request that caused it.
 */
@Injectable()
export class ServerEvents {
  private readonly enabled: boolean;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.enabled = config.ANALYTICS_ENABLED ?? config.NODE_ENV !== 'production';
  }

  async record(
    name: AnalyticsServerEvent,
    dedupeKey: string,
    profileId: string,
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      await recordServerEvent(this.database.db, { name, dedupeKey, profileId });
    } catch {
      this.logger.warn({ event: 'analytics.server_event_failed', name });
    }
  }
}
