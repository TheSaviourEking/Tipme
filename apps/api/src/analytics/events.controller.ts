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
  type AnalyticsEvent,
  type ApiDataResponse,
} from '@tipme/contracts';
import { recordClientEvent } from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
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
  private readonly enabled: boolean;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.enabled = config.ANALYTICS_ENABLED ?? config.NODE_ENV !== 'production';
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
    // The browser said "don't track me": honoured here too, not only in our own script.
    if (this.enabled && gpc !== '1' && dnt !== '1')
      await recordClientEvent(this.database.db, {
        event,
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
