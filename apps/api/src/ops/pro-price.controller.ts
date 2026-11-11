import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsProPriceChangeSchema,
  PRO_PRICE_MAX_MINOR,
  PRO_PRICE_MIN_MINOR,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsProPrice,
  type OpsProPriceChangeRequest,
  type OpsProPriceRow,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  currentProPrice,
  proPriceHistory,
  requestSeriousAction,
  waitingProPriceRequest,
  type ProPriceRow,
  type SeriousActionServices,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

const wire = (row: ProPriceRow): OpsProPriceRow => ({
  id: row.id,
  amountMinor: String(row.amountMinor),
  currency: row.currency,
  effectiveFrom: row.effectiveFrom.toISOString(),
  setBy: row.setBy,
  approvedBy: row.approvedBy,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The Pro price in admin (ADR-0015; board OpsProPrice). Reading is `pro.price` without a fresh code:
 * it shows prices and staff ids, no one's private details. A change is the serious action
 * `pro_price.change`: a second person approves, or a lone admin acts alone with an alert.
 */
@Controller('v1/ops/pro-price')
export class OpsProPriceController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  private async read(): Promise<OpsProPrice> {
    const [current, history, waitingRequestId] = await Promise.all([
      currentProPrice(this.database.db),
      proPriceHistory(this.database.db),
      waitingProPriceRequest(this.database.db),
    ]);
    return {
      current: current ? wire(current) : null,
      history: history.map(wire),
      limits: {
        minMinor: String(PRO_PRICE_MIN_MINOR),
        maxMinor: String(PRO_PRICE_MAX_MINOR),
      },
      waitingRequestId,
    };
  }

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('pro.price')
  async state(): Promise<ApiDataResponse<OpsProPrice>> {
    return { data: await this.read() };
  }

  @Post()
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('pro.price')
  async change(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsProPriceChangeSchema))
    body: OpsProPriceChangeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsProPrice & OpsActedAlone) | OpsSeriousPending>
  > {
    const answer = pendingOr(
      await requestSeriousAction(this.database.db, {
        name: 'pro_price.change',
        payload: { amountMinor: body.amountMinor },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    if ('pending' in answer) return { data: answer.pending };
    return {
      data: {
        ...(await this.read()),
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }
}
