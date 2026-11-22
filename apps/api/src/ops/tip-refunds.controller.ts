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
 * tip our payment partner says was paid by bank transfer is refused before anyone asks. A collect
 * tip (Task 10) is refunded from TipMe's balance once the recipient's part is back; when part of it
 * can't be, going ahead is `tip_refund.absorb_gap`, decided by a second person.
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
    if (facts.collect) {
      // You collect (Task 10): the payment is on TipMe's own account, read as TipMe.
      if (!provider) return undefined;
      try {
        const read = await provider.verifyTransaction(facts.providerReference);
        return read.method === 'NGN_BANK_TRANSFER'
          ? 'bank_transfer'
          : read.method === 'NGN_CARD'
            ? 'card'
            : undefined;
      } catch {
        // The worker reads it again before anything moves.
        return undefined;
      }
    }
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
        // You collect (Task 10) only: a direct tip's answer is unchanged.
        ...(facts.collect
          ? {
              collect: {
                plan: facts.collect.plan,
                gapMinor: String(facts.collect.gapMinor),
              },
              lastFailure: facts.lastFailure,
              heldMinor: String(facts.heldMinor),
              // Task 15 follow-up: pulled back from a business for a refund that then failed.
              businessHeldMinor: String(facts.businessHeldMinor),
              unbookedMinor: String(facts.unbookedMinor),
            }
          : {}),
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
    // You collect (Task 10): part of it can't be taken back; only `absorb-gap` goes ahead.
    if (facts.collect?.plan === 'staff_decides')
      throw new CodedHttpException(409, 'TIP_REFUND_NEEDS_DECISION');
    return this.request('tip.refund', ops, tipId, body, response);
  }

  /**
   * You collect (plan Task 10, spec §6.1 case 3): the recipient (or the business) no longer has all
   * of their part to give back. Going ahead has TipMe absorb up to the gap from its own balance: a
   * serious action of its own (`tip_refund.absorb_gap`), decided by a second person.
   */
  @Post(':tipId/refund/absorb-gap')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payments.repair')
  async absorbGap(
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
    if (facts.collect?.plan !== 'staff_decides')
      throw new CodedHttpException(409, 'TIP_REFUND_NO_GAP');
    return this.request('tip_refund.absorb_gap', ops, tipId, body, response);
  }

  /**
   * You collect (fix round 2, RI1): what a failed refund took back from the recipient goes back to
   * their account (`tip_refund.return`, a second person). Refused while a refund is open or a dispute
   * isn't won or closed, or with nothing held.
   */
  @Post(':tipId/refund/return')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('payments.repair')
  async returnHeld(
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
    if (
      !facts.collect ||
      (facts.heldMinor <= 0n && facts.businessHeldMinor <= 0n) ||
      facts.refund
    )
      throw new CodedHttpException(409, 'TIP_REFUND_REFUSED');
    return this.request('tip_refund.return', ops, tipId, body, response);
  }

  private async request(
    name: 'tip.refund' | 'tip_refund.absorb_gap' | 'tip_refund.return',
    ops: OpsContext,
    tipId: string,
    body: OpsTipRefundRequest,
    response: Response,
  ): Promise<
    ApiDataResponse<
      | ({ refundId: string; amountMinor: string } & OpsActedAlone)
      | OpsSeriousPending
    >
  > {
    const answer = pendingOr<{
      refundId?: string;
      returnId?: string;
      amountMinor: string;
    }>(
      await requestSeriousAction(this.database.db, {
        name,
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
        // A return (RI1) answers with the return transfer's id in the same place.
        refundId: answer.result.refundId ?? answer.result.returnId ?? '',
        amountMinor: answer.result.amountMinor,
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }
}
