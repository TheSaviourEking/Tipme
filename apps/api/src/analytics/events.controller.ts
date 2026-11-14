import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Module,
  Post,
} from '@nestjs/common';
import {
  analyticsEventSchema,
  webVitalSchema,
  type AnalyticsEvent,
  type ApiDataResponse,
  type WebVital,
} from '@tipme/contracts';
import { recordClientEvent, recordWebVital, featureOn } from '@tipme/database';
import { RateLimit, RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';

/** Anything that looks like a phone or tablet; the user agent itself is never stored. */
const MOBILE = /Mobi|Android|iPhone|iPad|iPod/i;

/**
 * Anonymous first-party events (ADR-0010): an allow-list of names and properties, no cookies, no
 * IP or user agent stored. Always 202, so a browser learns nothing from the answer.
 */
@Controller('v1')
export class EventsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  /** The browser said "don't track me": honoured here too, not only in our own script. */
  private async collecting(gpc?: string, dnt?: string): Promise<boolean> {
    return (
      gpc !== '1' && dnt !== '1' && featureOn(this.database.db, 'analytics')
    );
  }

  @Post('events')
  @HttpCode(202)
  @RateLimit('analytics')
  async record(
    @Body(new ZodValidationPipe(analyticsEventSchema)) event: AnalyticsEvent,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('sec-gpc') gpc: string | undefined,
    @Headers('dnt') dnt: string | undefined,
  ): Promise<ApiDataResponse<{ accepted: true }>> {
    if (await this.collecting(gpc, dnt))
      await recordClientEvent(this.database.db, {
        event,
        device: MOBILE.test(userAgent ?? '') ? 'mobile' : 'desktop',
      });
    return { data: { accepted: true } };
  }

  /** Real-user web vitals (PR-011): the same consent rules, switch and rate limit as events. */
  @Post('vitals')
  @HttpCode(202)
  @RateLimit('analytics')
  async vital(
    @Body(new ZodValidationPipe(webVitalSchema)) vital: WebVital,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('sec-gpc') gpc: string | undefined,
    @Headers('dnt') dnt: string | undefined,
  ): Promise<ApiDataResponse<{ accepted: true }>> {
    if (await this.collecting(gpc, dnt))
      await recordWebVital(this.database.db, {
        vital,
        device: MOBILE.test(userAgent ?? '') ? 'mobile' : 'desktop',
      });
    return { data: { accepted: true } };
  }
}

@Module({
  controllers: [EventsController],
  providers: [RateLimitGuard],
})
export class AnalyticsModule {}
