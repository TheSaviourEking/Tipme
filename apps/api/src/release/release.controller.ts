import { createHash, timingSafeEqual } from 'node:crypto';
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
import type { ApiDataResponse, ReleaseInfo } from '@tipme/contracts';
import { finishReleaseRun, openReleaseRun } from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';

/** What this copy of TipMe is, for the release check (PR-010). Public: it reveals no secrets. */
@Controller()
export class ReleaseInfoController {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

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
    const token = this.config.RELEASE_CHECK_TOKEN;
    const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
    const ok =
      this.config.RELEASE_KIND === 'test' &&
      Boolean(token) &&
      timingSafeEqual(digest(given), digest(token ?? ''));
    if (!ok) throw new CodedHttpException(404, 'NOT_FOUND');
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();
