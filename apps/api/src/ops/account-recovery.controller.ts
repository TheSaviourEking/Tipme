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
  opsEmailRecoverySchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsEmailRecoveryRequest,
  type OpsReasonRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  endAccountSessions,
  normaliseEmail,
  requestSeriousAction,
  type SeriousActionServices,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { sessionsChanged } from '@tipme/contracts';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Staff help someone who lost their email: they check identity, and the new owner proves it. */
@Controller('v1/ops/accounts')
export class OpsAccountRecoveryController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(LIVE_PUBLISHER) private readonly publishLive: PublishLive,
  ) {}

  @Post(':userId/email-recovery')
  @HttpCode(202)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('recoveries.manage')
  async startEmailRecovery(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsEmailRecoverySchema))
    body: OpsEmailRecoveryRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<{ outcome: 'code_sent' } | OpsSeriousPending>> {
    if (!UUID.test(userId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const newEmail = normaliseEmail(body.newEmail);
    if (!newEmail) throw new CodedHttpException(400, 'VALIDATION_FAILED');
    const answer = pendingOr<{ outcome: 'code_sent' }>(
      await requestSeriousAction(this.database.db, {
        name: 'email_recovery.start',
        payload: { userId, newEmail, checks: body.checks },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  /** A reported takeover: signs the account out everywhere. Audited with the reason. */
  @Post(':userId/end-sessions')
  @HttpCode(200)
  @OpsPermission('recoveries.manage')
  async endSessions(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ outcome: 'ended' }>> {
    if (!UUID.test(userId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const outcome = await endAccountSessions(this.database.db, {
      staffUserId: ops.userId,
      userId,
      reason: body.reason,
    });
    if (outcome === 'not_found') throw new CodedHttpException(404, 'NOT_FOUND');
    if (outcome === 'staff_account')
      throw new CodedHttpException(409, 'FORBIDDEN');
    void this.publishLive(sessionsChanged(userId));
    return { data: { outcome } };
  }
}
