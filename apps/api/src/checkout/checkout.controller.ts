import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import {
  tipIntentRequestSchema,
  tipQuoteRequestSchema,
  type ApiDataResponse,
  type TipIntentCreated,
  type TipIntentRequest,
  type TipQuote,
  type TipQuoteRequest,
} from '@tipme/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { CheckoutService } from './checkout.service.js';
import { RateLimit } from './rate-limit.guard.js';

const idempotencyKeyPipe = new ZodValidationPipe(z.uuid());

/** Public guest checkout: price a tip, then create it. */
@Controller('v1')
export class CheckoutController {
  constructor(
    @Inject(CheckoutService) private readonly checkout: CheckoutService,
  ) {}

  @Post('tip-quotes')
  @RateLimit('quotes')
  async quote(
    @Body(new ZodValidationPipe(tipQuoteRequestSchema)) body: TipQuoteRequest,
  ): Promise<ApiDataResponse<TipQuote>> {
    return { data: await this.checkout.quote(body) };
  }

  @Post('tip-intents')
  @RateLimit('intents')
  async intent(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(tipIntentRequestSchema)) body: TipIntentRequest,
  ): Promise<ApiDataResponse<TipIntentCreated>> {
    const key = idempotencyKeyPipe.transform(idempotencyKey, {
      type: 'custom',
      data: 'idempotency-key',
    });
    return { data: await this.checkout.createIntent(body, key) };
  }
}
