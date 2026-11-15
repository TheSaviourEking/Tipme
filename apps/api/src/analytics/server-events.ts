import { Inject, Injectable } from '@nestjs/common';
import type { AnalyticsServerEvent } from '@tipme/contracts';
import { recordServerEvent, featureOn } from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';

/**
 * Server-side analytics events the API itself knows about (PR-013, PRD v1.1 §11): a page created
 * or first published, a withdrawal requested. Off unless collection is on (D-07), once per
 * dedupe key, and never allowed to fail the request that caused it.
 */
@Injectable()
export class ServerEvents {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Whether anonymous analytics are collected at all (the `analytics` switch; on by default). */
  enabled(): Promise<boolean> {
    return featureOn(this.database.db, 'analytics');
  }

  async record(
    name: AnalyticsServerEvent,
    dedupeKey: string,
    profileId: string,
  ): Promise<void> {
    if (!(await this.enabled())) return;
    try {
      await recordServerEvent(this.database.db, { name, dedupeKey, profileId });
    } catch {
      this.logger.warn({ event: 'analytics.server_event_failed', name });
    }
  }
}
