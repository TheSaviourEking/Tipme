import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  opsAccountFeeSchema,
  opsFeeFreeGrantSchema,
  opsNoteSchema,
  opsReasonSchema,
  opsRecheckSchema,
  type ApiDataResponse,
  type OpsAccountFeeRequest,
  type OpsFeeFreeGrantRequest,
  type OpsNoteRequest,
  type OpsReasonRequest,
  type OpsRecheckOutcome,
  type OpsRecheckRequest,
} from '@tipme/contracts';
import {
  addIssueNote,
  cancelRecoveries,
  grantFeeFreeTips,
  removeAvatarByStaff,
  recheckSubject,
  recordAudit,
  resolveIssue,
  setAccountFee,
  setPageSuspension,
} from '@tipme/database';
import type { MockProvider } from '@tipme/payments';
import { PAYMENT_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidParam = (value: string) => {
  if (!UUID.test(value)) throw new CodedHttpException(404, 'NOT_FOUND');
  return value;
};

/**
 * Decisions staff can take (PR-009). None moves money: no refunds, adjustments or payout holds.
 * Pricing decisions (an account's fee, fee-free tips) change only future quotes (ADR-0014).
 * Every action needs a written reason and is audited in the same transaction.
 */
@Controller('v1/ops')
export class OpsActionsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly provider: MockProvider,
  ) {}

  @Post('issues/:id/resolve')
  @HttpCode(200)
  @OpsPermission('issues.resolve')
  async resolve(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ resolved: true }>> {
    await resolveIssue(this.database.db, {
      issueId: uuidParam(id),
      staffUserId: ops.userId,
      reason: body.reason,
    });
    return { data: { resolved: true } };
  }

  @Post('issues/:id/notes')
  @HttpCode(201)
  @OpsPermission('issues.view')
  async note(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsNoteSchema)) body: OpsNoteRequest,
  ): Promise<ApiDataResponse<{ id: string }>> {
    return {
      data: await addIssueNote(this.database.db, {
        issueId: uuidParam(id),
        staffUserId: ops.userId,
        text: body.text,
      }),
    };
  }

  @Post('pages/:profileId/suspend')
  @HttpCode(200)
  @OpsPermission('pages.suspend')
  suspend(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ handle: string }>> {
    return this.suspension(ops, profileId, body.reason, true);
  }

  @Post('pages/:profileId/unsuspend')
  @HttpCode(200)
  @OpsPermission('pages.suspend')
  unsuspend(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ handle: string }>> {
    return this.suspension(ops, profileId, body.reason, false);
  }

  /** Asks the provider about one attempt or payout; it never charges, pays or refunds. */
  @Post('recheck')
  @HttpCode(200)
  @OpsPermission('payments.recheck')
  async recheck(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsRecheckSchema)) body: OpsRecheckRequest,
  ): Promise<ApiDataResponse<{ outcome: OpsRecheckOutcome }>> {
    return {
      data: await recheckSubject({
        db: this.database.db,
        provider: this.provider,
        attemptId: body.attemptId,
        payoutId: body.payoutId,
        staffUserId: ops.userId,
        reason: body.reason,
      }),
    };
  }

  @Post('users/:userId/cancel-recovery')
  @HttpCode(200)
  @OpsPermission('recoveries.cancel')
  async cancelRecovery(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ cancelled: number }>> {
    const cancelled = await cancelRecoveries(
      this.database.db,
      uuidParam(userId),
    );
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'recovery.cancelled',
      permission: 'recoveries.cancel',
      subjectType: 'user',
      subjectId: userId,
      reason: `${body.reason} [cancelled: ${cancelled}]`,
    });
    return { data: { cancelled } };
  }

  private async suspension(
    ops: OpsContext,
    profileId: string,
    reason: string,
    suspend: boolean,
  ): Promise<ApiDataResponse<{ handle: string }>> {
    const { handle } = await setPageSuspension(this.database.db, {
      profileId: uuidParam(profileId),
      staffUserId: ops.userId,
      suspend,
      reason,
    });
    this.revalidator.revalidate(handle);
    return { data: { handle } };
  }

  @Post('pages/:profileId/fee')
  @HttpCode(200)
  @OpsPermission('fees.manage')
  setFee(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsAccountFeeSchema))
    body: OpsAccountFeeRequest,
  ): Promise<ApiDataResponse<{ handle: string; feeBps: number | null }>> {
    return setAccountFee(this.database.db, {
      profileId: uuidParam(profileId),
      staffUserId: ops.userId,
      feeBps: body.feeBps,
      reason: body.reason,
    }).then((data) => ({ data }));
  }

  @Post('pages/:profileId/fee-free')
  @HttpCode(200)
  @OpsPermission('fees.manage')
  grantFeeFree(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsFeeFreeGrantSchema))
    body: OpsFeeFreeGrantRequest,
  ): Promise<ApiDataResponse<{ remaining: number }>> {
    return grantFeeFreeTips(this.database.db, {
      profileId: uuidParam(profileId),
      staffUserId: ops.userId,
      count: body.count,
      reason: body.reason,
    }).then((data) => ({ data }));
  }

  /** Staff remove a page's photo (impersonation, abuse), with a reason the audit log keeps. */
  @Post('pages/:profileId/avatar/remove')
  @HttpCode(200)
  @OpsPermission('pages.suspend')
  async removeAvatar(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ removed: true }>> {
    const { handle } = await removeAvatarByStaff(this.database.db, {
      profileId: uuidParam(profileId),
      staffUserId: ops.userId,
      reason: body.reason,
    });
    this.revalidator.revalidate(handle);
    return { data: { removed: true } };
  }
}
