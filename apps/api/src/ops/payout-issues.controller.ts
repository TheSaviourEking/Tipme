import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  opsPayoutApplySchema,
  opsPayoutMarkFailedSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsPayoutActionResult,
  type OpsPayoutApplyRequest,
  type OpsPayoutIssueView,
  type OpsPayoutMarkFailedRequest,
  type OpsReasonRequest,
} from '@tipme/contracts';
import {
  applyReportedPayout,
  markPayoutFailedAbsent,
  readPayoutIssue,
  resumeHeldPayout,
  type PayoutStartLog,
  type StaffPayoutReader,
} from '@tipme/database';
import type { BachsProvider, MockProvider } from '@tipme/payments';
import type { Logger } from '@tipme/observability';
import {
  BACHS_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * Staff acting on a withdrawal issue. Each call reads the provider before anything else, and the
 * operation decides what that read allows, so nothing here trusts what a page last showed.
 */
@Controller('v1/ops/issues/:id')
export class OpsPayoutIssuesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly mock: MockProvider,
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly bachs: BachsProvider | null,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private common(ops: OpsContext, issueId: string) {
    return {
      issueId,
      staffUserId: ops.userId,
      provider: (name: string): StaffPayoutReader => {
        if (name === 'mock') return this.mock;
        if (name === 'bachs' && this.bachs) return this.bachs;
        throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
      },
      log: ((entry) => this.logger.warn({ ...entry })) as PayoutStartLog,
    };
  }

  @Post('payout-read')
  @HttpCode(200)
  @OpsPermission('payouts.resolve')
  async read(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsPayoutIssueView>> {
    return {
      data: await readPayoutIssue(this.database.db, this.common(ops, id)),
    };
  }

  @Post('payout-apply')
  @HttpCode(200)
  @OpsPermission('payouts.resolve')
  async apply(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsPayoutApplySchema))
    body: OpsPayoutApplyRequest,
  ): Promise<ApiDataResponse<OpsPayoutActionResult>> {
    return {
      data: await applyReportedPayout(this.database.db, {
        ...this.common(ops, id),
        reported: body.reported,
        reason: body.reason,
      }),
    };
  }

  @Post('payout-resume')
  @HttpCode(200)
  @OpsPermission('payouts.resolve')
  async resume(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsPayoutActionResult>> {
    return {
      data: await resumeHeldPayout(this.database.db, {
        ...this.common(ops, id),
        reason: body.reason,
      }),
    };
  }

  @Post('payout-mark-failed')
  @HttpCode(200)
  @OpsPermission('payouts.resolve')
  async markFailed(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsPayoutMarkFailedSchema))
    body: OpsPayoutMarkFailedRequest,
  ): Promise<ApiDataResponse<OpsPayoutActionResult>> {
    return {
      data: await markPayoutFailedAbsent(this.database.db, {
        ...this.common(ops, id),
        reason: body.reason,
        dashboardVerified: body.dashboardVerified,
      }),
    };
  }
}
