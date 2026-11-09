import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { ApiDataResponse, ProPrice } from '@tipme/contracts';
import { currentProPrice } from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';

/**
 * Paid Pro (ADR-0015): what a month of Pro costs today, for anyone. The server is the only source
 * of the price; the web app shows what this says and never a number of its own.
 */
@Controller('v1/pro')
export class ProPriceController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get('price')
  @Header('Cache-Control', 'public, max-age=60')
  async price(): Promise<ApiDataResponse<ProPrice>> {
    const price = await currentProPrice(this.database.db);
    if (!price) throw new CodedHttpException(404, 'PRO_PRICE_NOT_SET');
    return {
      data: {
        amountMinor: String(price.amountMinor),
        currency: price.currency,
        interval: 'month',
      },
    };
  }
}
