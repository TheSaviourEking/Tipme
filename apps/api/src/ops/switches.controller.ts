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
  FEATURE_SWITCH_CATALOGUE,
  isFeatureSwitch,
  opsFeatureSwitchSetSchema,
  type ApiDataResponse,
  type FeatureSwitch,
  type OpsActedAlone,
  type OpsFeatureSwitches,
  type OpsFeatureSwitchSetRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  featureSwitchOverview,
  requestSeriousAction,
  setFeatureSwitch,
  type SeriousActionServices,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FeatureSwitches } from '../switches/feature-switches.service.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

/**
 * Feature switches in admin (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md). Reading is
 * `switches.manage` without a fresh code: names, states, reasons and staff ids, nobody's private
 * details. A money switch is the serious action `feature_switch.set` (a second person when there is
 * one); any other changes here with a reason and a fresh code, audited.
 */
@Controller('v1/ops/switches')
export class OpsSwitchesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(FeatureSwitches) private readonly switches: FeatureSwitches,
  ) {}

  private async read(): Promise<OpsFeatureSwitches> {
    return { switches: await featureSwitchOverview(this.database.db) };
  }

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('switches.manage')
  async list(): Promise<ApiDataResponse<OpsFeatureSwitches>> {
    return { data: await this.read() };
  }

  @Post(':key')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('switches.manage')
  async set(
    @CurrentOps() ops: OpsContext,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(opsFeatureSwitchSetSchema))
    body: OpsFeatureSwitchSetRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsFeatureSwitches & OpsActedAlone) | OpsSeriousPending>
  > {
    if (!isFeatureSwitch(key)) throw new CodedHttpException(404, 'NOT_FOUND');
    const name: FeatureSwitch = key;
    if (FEATURE_SWITCH_CATALOGUE[name].money) {
      const answer = pendingOr(
        await requestSeriousAction(this.database.db, {
          name: 'feature_switch.set',
          payload: { key: name, on: body.on },
          actorId: ops.userId,
          grantId: ops.grantId,
          reason: body.reason,
          services: this.services,
        }),
        response,
      );
      if ('pending' in answer) return { data: answer.pending };
      this.switches.changed();
      return {
        data: {
          ...(await this.read()),
          ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
        },
      };
    }
    await this.database.db.transaction((tx) =>
      setFeatureSwitch(tx, {
        key: name,
        on: body.on,
        staffUserId: ops.userId,
        approvedBy: null,
        reason: body.reason,
        now: new Date(),
      }),
    );
    this.switches.changed();
    return { data: await this.read() };
  }
}
