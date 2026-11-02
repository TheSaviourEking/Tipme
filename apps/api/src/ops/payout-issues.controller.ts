import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
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
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  readPayoutForAction,
  readPayoutIssue,
  refuseToApply,
  refuseToMarkFailed,
  requestSeriousAction,
  type SeriousActionServices,
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
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
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
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
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
  @FreshCode()
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
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payouts.resolve')
  async apply(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsPayoutApplySchema))
    body: OpsPayoutApplyRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<OpsPayoutActionResult | OpsSeriousPending>> {
    const input = {
      ...this.common(ops, id),
      reported: body.reported,
      reason: body.reason,
    };
    // A request nobody could ever approve isn't asked: the screen hears why, as it always did.
    const refusal = await refuseToApply(
      this.database.db,
      input,
      await readPayoutForAction(this.database.db, input),
    );
    if (refusal) return { data: refusal };
    const answer = pendingOr<OpsPayoutActionResult>(
      await requestSeriousAction(this.database.db, {
        name: 'payout.settle',
        payload: { issueId: id, how: 'apply', reported: body.reported },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  @Post('payout-resume')
  @HttpCode(200)
  @FreshCode()
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
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payouts.resolve')
  async markFailed(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsPayoutMarkFailedSchema))
    body: OpsPayoutMarkFailedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<OpsPayoutActionResult | OpsSeriousPending>> {
    const input = { ...this.common(ops, id), reason: body.reason };
    const refusal = await refuseToMarkFailed(
      this.database.db,
      input,
      await readPayoutForAction(this.database.db, input),
    );
    if (refusal) return { data: refusal };
    const answer = pendingOr<OpsPayoutActionResult>(
      await requestSeriousAction(this.database.db, {
        name: 'payout.settle',
        payload: { issueId: id, how: 'mark_failed' },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }
}
