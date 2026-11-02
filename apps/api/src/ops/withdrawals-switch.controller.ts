import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  opsWithdrawalsSwitchSchema,
  type ApiDataResponse,
  type OpsWithdrawalsSwitchRequest,
} from '@tipme/contracts';
import { setWithdrawalsPaused } from '@tipme/database';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/** Staff stop or restart all withdrawals, with a written reason. No deploy, on every copy at once. */
@Controller('v1/ops/withdrawals-switch')
export class OpsWithdrawalsSwitchController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Post()
  @HttpCode(200)
  @OpsPermission('payouts.resolve')
  async set(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsWithdrawalsSwitchSchema))
    body: OpsWithdrawalsSwitchRequest,
  ): Promise<ApiDataResponse<{ changed: boolean }>> {
    return {
      data: await setWithdrawalsPaused(this.database.db, {
        paused: body.paused,
        staffUserId: ops.userId,
        reason: body.reason,
      }),
    };
  }
}
