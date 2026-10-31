import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import type {
  ApiDataResponse,
  BackupHealth,
  ReleaseInfo,
} from '@tipme/contracts';
import {
  backupStatus,
  retentionBlockCode,
  finishReleaseRun,
  openReleaseRun,
  type BackupStatus,
} from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { bearerMatches } from '../http/bearer.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';

/** What this copy of TipMe is, for the release check (PR-010). Public: it reveals no secrets. */
@Controller()
export class ReleaseInfoController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get('health/release')
  @Header('Cache-Control', 'no-store')
  info(): ApiDataResponse<ReleaseInfo> {
    return {
      data: {
        kind: this.config.RELEASE_KIND,
        version: this.config.GIT_SHA ?? 'unknown',
        deploymentMode: this.config.DEPLOYMENT_MODE,
        // Live payments cannot be configured yet (D-03); the check fails if this ever turns true.
        paymentsLive: (this.config.PAYMENTS_LIVE_ENABLED as string) === 'true',
        analytics:
          this.config.ANALYTICS_ENABLED ??
          this.config.NODE_ENV !== 'production',
        paymentProvider: this.config.PAYMENT_PROVIDER,
      },
    };
  }

  /**
   * Backup freshness for alerts (PR-011): ages and counts only, never file names or contents.
   * Public like the other health routes so the watcher needs no credentials.
   */
  // Public (for the watcher), so the database answer is shared for 30 seconds: a flood of
  // requests costs no queries. Ages are still computed per request from the cached times.
  private cachedStatus: { at: number; status: Promise<BackupStatus> } | null =
    null;

  @Get('health/backups')
  @Header('Cache-Control', 'no-store')
  async backups(): Promise<ApiDataResponse<BackupHealth>> {
    const now = Date.now();
    if (!this.cachedStatus || now - this.cachedStatus.at >= 30_000) {
      const pending = backupStatus(this.database.db);
      this.cachedStatus = { at: now, status: pending };
      // A failed lookup is never cached.
      pending.catch(() => {
        if (this.cachedStatus?.status === pending) this.cachedStatus = null;
      });
    }
    const status = await this.cachedStatus.status;
    const age = (iso: string | null | undefined) =>
      iso ? Math.round((now - Date.parse(iso)) / 60_000) : null;
    return {
      data: {
        pointInTime: this.config.POINT_IN_TIME_RECOVERY,
        logical: status.logical
          ? { ageMinutes: age(status.logical.at)! }
          : null,
        base: status.base ? { ageMinutes: age(status.base.at)! } : null,
        wal: {
          archiving: status.wal.archiving,
          lastArchivedAgeMinutes: age(status.wal.lastArchivedAt),
          lastFailedAgeMinutes: age(status.wal.lastFailedAt),
          failedCount: status.wal.failedCount,
        },
        retention: status.retention
          ? {
              lastRunAgeMinutes: age(status.retention.at)!,
              mode: status.retention.mode,
              outcome: status.retention.outcome,
              blocked: [
                ...new Set(status.retention.blocked.map(retentionBlockCode)),
              ],
              archiveBytes: status.retention.archiveBytes,
              candidateBytes: status.retention.candidateBytes,
              diskFreePercent: status.retention.diskFreePercent,
            }
          : null,
      },
    };
  }
}

/**
 * Release-check runs (PR-010): only on copies that say RELEASE_KIND=test, only with the check's
 * bearer token. Everything else answers 404, so a live copy reveals nothing.
 */
@Controller('v1/release/runs')
export class ReleaseRunsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Post()
  @HttpCode(201)
  async open(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<ApiDataResponse<{ runId: string }>> {
    this.authorise(authorization);
    return { data: await openReleaseRun(this.database.db) };
  }

  @Post(':id/finish')
  @HttpCode(200)
  async finish(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<{ issuesClosed: number }>> {
    this.authorise(authorization);
    const result = await finishReleaseRun(this.database.db, { runId: id });
    if (!result) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: result };
  }

  private authorise(authorization: string | undefined): void {
    const ok =
      this.config.RELEASE_KIND === 'test' &&
      bearerMatches(authorization, this.config.RELEASE_CHECK_TOKEN);
    if (!ok) throw new CodedHttpException(404, 'NOT_FOUND');
  }
}
