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
  opsPlanFeesChangeSchema,
  PLAN_FEE_MAX_BPS,
  PLAN_FEE_MIN_BPS,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsPlanFees,
  type OpsPlanFeesChangeRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  featureOn,
  planFeeRateHistory,
  planFeeRatesInForce,
  requestSeriousAction,
  waitingPlanFeesRequest,
  type SeriousActionServices,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

/**
 * TipMe's fee per plan in admin (owner, 18 Nov 2026), like the Pro price screen. Reading is
 * `fees.manage` without a fresh code: rates, reasons and staff ids, no one's private details. A
 * change is the serious action `plan_fees.change`: a second person approves (or a lone admin acts
 * alone with an alert, as every money switch), audited, for new quotes only. Quotes read the rates
 * from the database on each quote, so there is no cache to clear.
 */
@Controller('v1/ops/plan-fees')
export class OpsPlanFeesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  private async read(): Promise<OpsPlanFees> {
    const db = this.database.db;
    const [current, history, waitingRequestId, payoutFeeAbsorbed] =
      await Promise.all([
        planFeeRatesInForce(db),
        planFeeRateHistory(db),
        waitingPlanFeesRequest(db),
        featureOn(db, 'business_payout_fee_absorbed'),
      ]);
    return {
      current: {
        freeBps: Number(current.freeBps),
        proBps: Number(current.proBps),
        source: current.source,
        effectiveFrom: current.row?.effectiveFrom.toISOString() ?? null,
      },
      history: history.map((row) => ({
        id: row.id,
        freeBps: row.freeBps,
        proBps: row.proBps,
        effectiveFrom: row.effectiveFrom.toISOString(),
        setBy: row.setBy,
        approvedBy: row.approvedBy,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
      limits: { minBps: PLAN_FEE_MIN_BPS, maxBps: PLAN_FEE_MAX_BPS },
      waitingRequestId,
      business: { payoutFeeAbsorbed },
    };
  }

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('fees.manage')
  async state(): Promise<ApiDataResponse<OpsPlanFees>> {
    return { data: await this.read() };
  }

  @Post()
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('fees.manage')
  async change(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsPlanFeesChangeSchema))
    body: OpsPlanFeesChangeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsPlanFees & OpsActedAlone) | OpsSeriousPending>
  > {
    const answer = pendingOr(
      await requestSeriousAction(this.database.db, {
        name: 'plan_fees.change',
        payload: {
          freeBps: body.freeBps,
          proBps: body.proBps,
          ...(body.confirmLargeChange ? { confirmLargeChange: true } : {}),
        },
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
