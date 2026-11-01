import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  opsApprovalListSchema,
  opsApproveSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsApproval,
  type OpsApprovalApproved,
  type OpsApprovalListQuery,
  type OpsApproveRequest,
  type OpsReasonRequest,
} from '@tipme/contracts';
import {
  approveRequest,
  cancelRequest,
  listApprovals,
  rejectRequest,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { uuidParam } from './actions.controller.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsAnyStaff } from './permission.decorator.js';

/**
 * Deciding serious actions. A request needs whichever permission its action names, so no one route
 * permission fits: the operations authorise each person against each request.
 */
@Controller('v1/ops/approvals')
export class OpsApprovalsController {
  private readonly key: Buffer;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.key = Buffer.from(config.OPS_TOTP_KEY, 'base64');
  }

  @Get()
  @OpsAnyStaff()
  async list(
    @CurrentOps() ops: OpsContext,
    @Query(new ZodValidationPipe(opsApprovalListSchema))
    query: OpsApprovalListQuery,
  ): Promise<ApiDataResponse<OpsApproval[]>> {
    return {
      data: await listApprovals(this.database.db, {
        actorId: ops.userId,
        ...(query.status ? { status: query.status } : {}),
      }),
    };
  }

  // No @FreshCode: the code in the body is the proof, and asking for a recent one as well would
  // mean entering two, 30 seconds apart. Budgeted per person, as for re-entering a code.
  @Post(':id/approve')
  @HttpCode(200)
  @RateLimit('ops_code')
  @OpsAnyStaff()
  async approve(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsApproveSchema)) body: OpsApproveRequest,
  ): Promise<ApiDataResponse<OpsApprovalApproved>> {
    const outcome = await approveRequest(this.database.db, {
      requestId: uuidParam(id),
      actorId: ops.userId,
      code: body.code,
      key: this.key,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    switch (outcome.status) {
      case 'approved':
        return { data: { status: 'approved' } };
      case 'stale':
        throw new CodedHttpException(409, 'APPROVAL_STALE');
      case 'expired':
        throw new CodedHttpException(409, 'APPROVAL_EXPIRED');
      case 'reused':
        throw new CodedHttpException(400, 'CODE_ALREADY_USED');
      case 'locked':
        throw new CodedHttpException(429, 'OPS_LOCKED');
      case 'invalid':
        throw new CodedHttpException(400, 'CODE_INVALID');
    }
  }

  @Post(':id/reject')
  @HttpCode(200)
  @FreshCode()
  @OpsAnyStaff()
  async reject(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ status: 'rejected' }>> {
    await rejectRequest(this.database.db, {
      requestId: uuidParam(id),
      actorId: ops.userId,
      grantId: ops.grantId,
      reason: body.reason,
    });
    return { data: { status: 'rejected' } };
  }

  /** Open to the requester even if they have since lost the permission: it only stops something. */
  @Post(':id/cancel')
  @HttpCode(200)
  @OpsAnyStaff()
  async cancel(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<{ status: 'cancelled' }>> {
    await cancelRequest(this.database.db, {
      requestId: uuidParam(id),
      actorId: ops.userId,
    });
    return { data: { status: 'cancelled' } };
  }
}
