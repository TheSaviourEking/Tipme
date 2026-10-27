import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { ApiDataResponse } from '@tipme/contracts';
import type { Logger } from '@tipme/observability';
import type { BachsProvider } from '@tipme/payments';
import type { Request } from 'express';
import { DependencyUnavailableError } from '../http/api-exception.filter.js';
import { BACHS_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';
import { isRetryablePersistenceError } from './retryable.js';
import { WebhookService } from './webhook.service.js';
import { LOGGER } from '../tokens.js';

@Controller('v1/webhooks/bachs')
export class BachsWebhookController {
  constructor(
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly provider: BachsProvider | null,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly webhooks: WebhookService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
  ): Promise<ApiDataResponse<{ outcome: string }>> {
    if (!this.provider) throw new NotFoundException();

    const verification = this.provider.verifyWebhook(
      request.rawBody ?? Buffer.alloc(0),
      request.headers,
    );
    if (!verification.ok) {
      this.logger.warn({
        event: 'webhook.rejected',
        provider: 'bachs',
        reason: verification.reason,
      });
      if (verification.reason === 'malformed') throw new BadRequestException();
      throw new UnauthorizedException();
    }

    try {
      const outcome = await this.webhooks.applyBachs(
        verification.event,
        this.provider,
      );
      this.logger.info({
        event: 'webhook.processed',
        provider: 'bachs',
        type: verification.event.eventType,
        outcome,
      });
      return { data: { outcome } };
    } catch (error) {
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
