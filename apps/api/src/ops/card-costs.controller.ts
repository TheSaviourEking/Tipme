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
  opsCardCostsChangeSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsCardCosts,
  type OpsCardCostsChangeRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  cardCostHistory,
  cardCostInForce,
  requestSeriousAction,
  waitingCardCostsRequest,
  type SeriousActionServices,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

/**
 * What a card payment costs TipMe (owner, 26 Nov 2026), on the Plan fees screen: the card fee rate,
 * the 3D Secure fixed cost and a margin. Card is offered on a tip only when TipMe's share covers
 * them. Reading is `fees.manage` without a fresh code (numbers, reasons and staff ids). A change is
 * the serious action `card_costs.change`: a second person approves (or a lone admin acts alone with
 * the alert), audited. Checkouts read the cost from the database, so there is no cache to clear.
 */
@Controller('v1/ops/card-costs')
export class OpsCardCostsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  private async read(): Promise<OpsCardCosts> {
    const db = this.database.db;
    const now = new Date();
    // The cost and its row from one query, so "in use since" matches the cost shown.
    const [{ cost: current, row }, history, waitingRequestId] =
      await Promise.all([
        cardCostInForce(db, now),
        cardCostHistory(db, 50),
        waitingCardCostsRequest(db),
      ]);
    return {
      current: {
        rateBps: Number(current.rateBps),
        fixedMinor: String(current.fixedMinor),
        marginMinor: String(current.marginMinor),
        source: row ? 'setting' : 'default',
        effectiveFrom: row?.effectiveFrom.toISOString() ?? null,
      },
      history: history.map((entry) => ({
        id: entry.id,
        rateBps: entry.rateBps,
        fixedMinor: String(entry.fixedMinor),
        marginMinor: String(entry.marginMinor),
        effectiveFrom: entry.effectiveFrom.toISOString(),
        setBy: entry.setBy,
        approvedBy: entry.approvedBy,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      })),
      waitingRequestId,
    };
  }

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('fees.manage')
  async state(): Promise<ApiDataResponse<OpsCardCosts>> {
    return { data: await this.read() };
  }

  @Post()
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('fees.manage')
  async change(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsCardCostsChangeSchema))
    body: OpsCardCostsChangeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsCardCosts & OpsActedAlone) | OpsSeriousPending>
  > {
    const answer = pendingOr(
      await requestSeriousAction(this.database.db, {
        name: 'card_costs.change',
        payload: {
          rateBps: body.rateBps,
          fixedMinor: body.fixedMinor,
          marginMinor: body.marginMinor,
        },
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
        ...(await this.read()),
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }
}
