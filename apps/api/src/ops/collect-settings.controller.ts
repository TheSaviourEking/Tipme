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
  opsCollectSettingsChangeSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsCollectSettings,
  type OpsCollectSettingsChangeRequest,
  type OpsReasonRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  collectSettingsHistory,
  collectSettingsInForce,
  collectSettingsPayload,
  COLLECT_SETTINGS_CHANGE_ACTION,
  COLLECT_TRANSFERS_PAUSE_ACTION,
  COLLECT_TRANSFERS_RESUME_ACTION,
  requestSeriousAction,
  waitingCollectSettingsRequest,
  type SeriousActionServices,
} from '@tipme/database';
import { withdrawalMinimumMinor } from '@tipme/domain';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

type Answer = ApiDataResponse<
  (OpsCollectSettings & OpsActedAlone) | OpsSeriousPending
>;

/**
 * You collect's settings in admin (plan Task 12, spec §9), like the plan fee screen. Reading is
 * `fees.manage` without a fresh code: amounts, days, reasons and staff ids, nobody's private
 * details. A change is the serious action `collect_settings.change`: a second person approves (or a
 * lone admin acts alone with the alert), audited, in force at once. Staff's pause and resume of every
 * collect transfer (R11) are `collect_transfers.pause` and `.resume`, on `payments.repair`. Everything
 * that uses the settings reads them from the database when used, so there is no cache to clear.
 */
@Controller('v1/ops')
export class OpsCollectSettingsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  private async read(): Promise<OpsCollectSettings> {
    const db = this.database.db;
    const [current, history, waitingRequestId] = await Promise.all([
      collectSettingsInForce(db),
      collectSettingsHistory(db),
      waitingCollectSettingsRequest(db),
    ]);
    return {
      current: {
        ...collectSettingsPayload(current),
        paused: current.paused,
        source: current.source,
        effectiveFrom:
          history
            .find((row) => row.id === current.rowId)
            ?.effectiveFrom.toISOString() ?? null,
      },
      history: history.map((row) => ({
        id: row.id,
        ...collectSettingsPayload(row),
        paused: row.paused,
        effectiveFrom: row.effectiveFrom.toISOString(),
        setBy: row.setBy,
        approvedBy: row.approvedBy,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
      minWithdrawalMinor: withdrawalMinimumMinor().toString(),
      waitingRequestId,
    };
  }

  private async ask(
    ops: OpsContext,
    name: string,
    payload: Record<string, unknown>,
    reason: string,
    response: Response,
  ): Promise<Answer> {
    const answer = pendingOr(
      await requestSeriousAction(this.database.db, {
        name,
        payload,
        actorId: ops.userId,
        grantId: ops.grantId,
        reason,
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

  @Get('collect-settings')
  @RateLimit('ops_read')
  @OpsPermission('fees.manage')
  async state(): Promise<ApiDataResponse<OpsCollectSettings>> {
    return { data: await this.read() };
  }

  @Post('collect-settings')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('fees.manage')
  change(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsCollectSettingsChangeSchema))
    body: OpsCollectSettingsChangeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Answer> {
    const { reason, ...settings } = body;
    return this.ask(
      ops,
      COLLECT_SETTINGS_CHANGE_ACTION,
      settings,
      reason,
      response,
    );
  }

  @Post('collect-transfers/pause')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payments.repair')
  pause(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Answer> {
    return this.ask(
      ops,
      COLLECT_TRANSFERS_PAUSE_ACTION,
      {},
      body.reason,
      response,
    );
  }

  @Post('collect-transfers/resume')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payments.repair')
  resume(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Answer> {
    return this.ask(
      ops,
      COLLECT_TRANSFERS_RESUME_ACTION,
      {},
      body.reason,
      response,
    );
  }
}
