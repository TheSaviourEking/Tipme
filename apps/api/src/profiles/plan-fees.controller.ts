import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { ApiDataResponse, PublicPlanFees } from '@tipme/contracts';
import { planFeeRatesInForce } from '@tipme/database';
import { DatabaseProvider } from '../infra/database.js';

/**
 * TipMe's fee per plan today (owner, 18 Nov 2026), for anyone: the rates new quotes use, so copy on
 * the home, Pro and settings pages states the live numbers. The quote itself never reads this route:
 * it reads the database. With no stored rates this is the coded defaults (Free 5%, Pro 3%).
 */
@Controller('v1/plan-fees')
export class PlanFeesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  async rates(): Promise<ApiDataResponse<PublicPlanFees>> {
    const rates = await planFeeRatesInForce(this.database.db);
    return {
      data: { freeBps: Number(rates.freeBps), proBps: Number(rates.proBps) },
    };
  }
}
