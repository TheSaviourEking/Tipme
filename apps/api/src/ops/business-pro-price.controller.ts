import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
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
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  currentProPrice,
  proPriceHistory,
  requestSeriousAction,
  waitingProPriceRequest,
  type SeriousActionServices,
} from '@tipme/database';
import { BusinessProEnabledGuard } from '../business/business-pro-enabled.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { wireProPrice } from './pro-price.controller.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

/**
 * The Business Pro price in admin (owner, 14 Nov 2026; plan Task A5; board BusinessPro section 4).
 * The same contract and rules as `/v1/ops/pro-price`, on plan 'business': reading is `pro.price`,
 * a change is the serious action `business_pro_price.change` (a second person approves, or a lone
 * admin acts alone with an alert). 404 unless BUSINESS_ENABLED and BUSINESS_PRO_ENABLED.
 */
@Controller('v1/ops/business-pro-price')
@UseGuards(BusinessProEnabledGuard)
export class OpsBusinessProPriceController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  private async read(): Promise<OpsProPrice> {
    const { db } = this.database;
    const [current, history, waitingRequestId] = await Promise.all([
      currentProPrice(db, new Date(), 'business'),
      proPriceHistory(db, 50, 'business'),
      waitingProPriceRequest(db, 'business_pro_price.change'),
    ]);
    return {
      current: current ? wireProPrice(current) : null,
      history: history.map(wireProPrice),
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
        name: 'business_pro_price.change',
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
