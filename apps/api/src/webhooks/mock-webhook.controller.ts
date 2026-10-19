import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { ApiDataResponse } from '@tipme/contracts';
import type { Logger } from '@tipme/observability';
import { createMockProvider, type MockProvider } from '@tipme/payments';
import type { Redis } from 'ioredis';
import { LOGGER } from '../tokens.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DependencyUnavailableError } from '../http/api-exception.filter.js';
import { REDIS } from '../infra/infra.module.js';
import { isRetryablePersistenceError } from './retryable.js';
import { WebhookService } from './webhook.service.js';

/** Mock provider webhooks. Authenticated on the raw bytes before anything is parsed or stored. */
@Controller('v1/webhooks/mock')
export class MockWebhookController {
  private readonly provider: MockProvider;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(REDIS) redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly webhooks: WebhookService,
  ) {
    this.provider = createMockProvider({
      redis,
      secret: config.MOCK_PROVIDER_WEBHOOK_SECRET ?? '',
      prefix: config.QUEUE_PREFIX,
    });
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
  ): Promise<ApiDataResponse<{ outcome: string }>> {
    const verification = this.provider.verifyWebhook(
      request.rawBody ?? Buffer.alloc(0),
      request.headers,
    );
    if (!verification.ok) {
      // Reason only: never the body, the signature or the secret.
      this.logger.warn({
        event: 'webhook.rejected',
        provider: 'mock',
        reason: verification.reason,
      });
      if (verification.reason === 'malformed') throw new BadRequestException();
      throw new UnauthorizedException();
    }
    try {
      const outcome = await this.webhooks.apply(verification.event);
      this.logger.info({
        event: 'webhook.processed',
        provider: 'mock',
        type: verification.event.type,
        outcome,
      });
      return { data: { outcome } };
    } catch (error) {
      // 503 only when retrying can help (database unavailable); the event was not stored.
      if (
        error instanceof Error &&
        isRetryablePersistenceError(error as Error & { sqlState?: string })
      ) {
        throw new DependencyUnavailableError('database unavailable');
      }
      throw error;
    }
  }
}
