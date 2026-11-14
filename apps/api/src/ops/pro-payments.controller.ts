import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsProRefundSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsProPayment,
  type OpsProRefundRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  opsProPayments,
  requestSeriousAction,
  type SeriousActionServices,
  featureOn,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Pro refunds in admin (plan Task 9; ruling 6), behind PRO_REFUNDS (off by default). Staff with
 * `payments.repair` see a page's Pro payments and ask to refund a card one on the member's request;
 * a second person decides (`pro.refund`). The refund screen itself is a follow-up.
 */
@Controller('v1/ops/pro')
export class OpsProPaymentsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  private async on(): Promise<void> {
    if (!(await featureOn(this.database.db, 'pro_refunds')))
      throw new CodedHttpException(404, 'PRO_REFUNDS_OFF');
  }

  @Get('pages/:profileId/payments')
  @RateLimit('ops_read')
  @OpsPermission('payments.repair')
  async list(
    @Param('profileId') profileId: string,
  ): Promise<ApiDataResponse<OpsProPayment[]>> {
    await this.on();
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const rows = await opsProPayments(this.database.db, profileId, new Date());
    return {
      data: rows.map((row) => ({
        purchaseId: row.purchaseId,
        amountMinor: String(row.amountMinor),
        currency: 'NGN',
        paidAt: row.paidAt?.toISOString() ?? null,
        paidBy: row.paidBy as OpsProPayment['paidBy'],
        refundable: row.refundable,
        words: row.words,
        refund: row.refund ? { status: row.refund.status } : null,
      })),
    };
  }

  @Post('purchases/:purchaseId/refund')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payments.repair')
  async refund(
    @CurrentOps() ops: OpsContext,
    @Param('purchaseId') purchaseId: string,
    @Body(new ZodValidationPipe(opsProRefundSchema)) body: OpsProRefundRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<
      | ({ refundId: string; amountMinor: string } & OpsActedAlone)
      | OpsSeriousPending
    >
  > {
    await this.on();
    if (!UUID.test(purchaseId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const answer = pendingOr<{ refundId: string; amountMinor: string }>(
      await requestSeriousAction(this.database.db, {
        name: 'pro.refund',
        payload: { purchaseId },
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
        refundId: answer.result.refundId,
        amountMinor: answer.result.amountMinor,
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }
}
