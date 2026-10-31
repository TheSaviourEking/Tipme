import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  opsEmailRecoverySchema,
  type ApiDataResponse,
  type OpsEmailRecoveryRequest,
} from '@tipme/contracts';
import { startStaffRecovery, type MailSealing } from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Staff help someone who lost their email: they check identity, and the new owner proves it. */
@Controller('v1/ops/accounts')
export class OpsAccountRecoveryController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
  ) {}

  @Post(':userId/email-recovery')
  @HttpCode(202)
  @OpsPermission('recoveries.manage')
  async startEmailRecovery(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsEmailRecoverySchema))
    body: OpsEmailRecoveryRequest,
  ): Promise<ApiDataResponse<{ outcome: 'code_sent' }>> {
    if (!UUID.test(userId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const outcome = await startStaffRecovery(this.database.db, this.sealing, {
      staffUserId: ops.userId,
      userId,
      newEmail: body.newEmail,
      checks: body.checks,
      reason: body.reason,
      secret: this.config.AUTH_CODE_SECRET,
    });
    if (outcome === 'not_found') throw new CodedHttpException(404, 'NOT_FOUND');
    if (outcome === 'staff_account')
      throw new CodedHttpException(409, 'FORBIDDEN');
    if (outcome === 'invalid')
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    return { data: { outcome } };
  }
}
