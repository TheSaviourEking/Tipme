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
  opsTipRefundSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsSeriousPending,
  type OpsTipRefund,
  type OpsTipRefundRequest,
} from '@tipme/contracts';
import {
  featureOn,
  requestSeriousAction,
  tipRefundFacts,
  type SeriousActionServices,
  type TipRefundFacts,
} from '@tipme/database';
import type { BachsProvider, MockProvider } from '@tipme/payments';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  BACHS_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Staff "Refund tip" (owner, 14 Nov 2026), behind the `tip_refunds` admin switch (a money switch,
 * off by default). Staff with
 * `payments.repair` see what the supporter gets back (the tip minus TipMe's fee) and who gives back
 * what, and ask with a written reason and a fresh code; a second person decides (`tip.refund`). A
 * tip our payment partner says was paid by bank transfer is refused before anyone asks.
 */
@Controller('v1/ops/tips')
export class OpsTipRefundsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly mock: MockProvider,
    @Inject(BACHS_PROVIDER_TOKEN) private readonly bachs: BachsProvider | null,
  ) {}

  private async on(tipId: string): Promise<void> {
    if (!(await featureOn(this.database.db, 'tip_refunds')))
      throw new CodedHttpException(404, 'TIP_REFUNDS_OFF');
    if (!UUID.test(tipId)) throw new CodedHttpException(404, 'NOT_FOUND');
  }

  /** The partner's own answer on how the tip was paid; unknown (null) when it can't be read now. */
  private async method(
    facts: TipRefundFacts,
  ): Promise<'card' | 'bank_transfer' | 'other' | undefined> {
    if (!facts.refundable || !facts.providerReference) return undefined;
    const provider =
      facts.provider === 'mock'
        ? this.mock
        : facts.provider === 'bachs'
          ? this.bachs
          : null;
    if (!provider?.readAccountCharge) return undefined;
    try {
      return (await provider.readAccountCharge(facts.providerReference)).method;
    } catch {
      // The worker's own call decides then: a bank transfer is refused there too.
      return undefined;
    }
  }

  private async facts(tipId: string): Promise<TipRefundFacts> {
    const facts = await tipRefundFacts(this.database.db, tipId).catch(() => {
      throw new CodedHttpException(404, 'NOT_FOUND');
    });
    const method = await this.method(facts);
    return method === 'bank_transfer'
      ? tipRefundFacts(this.database.db, tipId, { method })
      : facts;
  }

  @Get(':tipId/refund')
  @RateLimit('ops_read')
  @OpsPermission('payments.repair')
  async read(
    @Param('tipId') tipId: string,
  ): Promise<ApiDataResponse<OpsTipRefund>> {
    await this.on(tipId);
    const facts = await this.facts(tipId);
    return {
      data: {
        tipId: facts.tipId,
        refundable: facts.refundable,
        refusal: facts.refusal,
        words: facts.words,
        handle: facts.handle,
        businessName: facts.businessName,
        currency: 'NGN',
        grossMinor: String(facts.grossMinor),
        feeMinor: String(facts.feeMinor),
        refundMinor: String(facts.refundMinor),
        personMinor: String(facts.personMinor),
        businessMinor: String(facts.businessMinor),
        refund: facts.refund ? { status: facts.refund.status } : null,
      },
    };
  }

  @Post(':tipId/refund')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payments.repair')
  async refund(
    @CurrentOps() ops: OpsContext,
    @Param('tipId') tipId: string,
    @Body(new ZodValidationPipe(opsTipRefundSchema)) body: OpsTipRefundRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<
      | ({ refundId: string; amountMinor: string } & OpsActedAlone)
      | OpsSeriousPending
    >
  > {
    await this.on(tipId);
    const facts = await this.facts(tipId);
    if (!facts.refundable)
      throw new CodedHttpException(409, 'TIP_REFUND_REFUSED');
    const answer = pendingOr<{ refundId: string; amountMinor: string }>(
      await requestSeriousAction(this.database.db, {
        name: 'tip.refund',
        payload: { tipId },
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
        refundId: answer.result.refundId,
        amountMinor: answer.result.amountMinor,
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }
}
