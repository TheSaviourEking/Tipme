import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { ApiDataResponse } from '@tipme/contracts';
import {
  findCheckoutByReference,
  findProPurchaseByReference,
  myProPurchaseById,
  OperationError,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import {
  mockProviderFee,
  planScenario,
  runScenario,
  type MockProvider,
} from '@tipme/payments';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import { PAYMENT_PROVIDER_TOKEN } from './payment-provider.provider.js';

const REFERENCE = /^mock_pay_[0-9a-f-]{36}$/;
// Paid Pro (ADR-0015): a pretend checkout on TipMe's own account.
const PRO_REFERENCE = /^mock_pro_[0-9a-f-]{36}$/;
const outcomeSchema = z
  .object({
    outcome: z.enum([
      'succeed',
      'decline',
      'pending-then-succeed',
      'no-reply',
      'wrong-amount',
    ]),
    // Pro only: how the pretend payer paid. Tips ignore it.
    method: z.enum(['card', 'bank_transfer']).optional(),
  })
  .strict();

/**
 * The pretend provider's hosted checkout (development only: the mock is refused in production).
 * Choosing an outcome plays the PR-006 scenario as signed webhooks to this API, exactly as a real
 * provider would; the status screen then reads only what those webhooks proved.
 */
@Controller('v1/mock-provider/checkout')
export class MockCheckoutController {
  private readonly webOrigin: string;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly provider: MockProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.webOrigin = new URL(config.WEB_ORIGIN).origin;
  }

  @Get(':reference')
  async summary(@Param('reference') reference: string): Promise<
    ApiDataResponse<{
      amountMinor: string;
      currency: string;
      recipientDisplayName: string;
    }>
  > {
    if (PRO_REFERENCE.test(reference)) {
      const purchase = await this.findPro(reference);
      return {
        data: {
          amountMinor: purchase.amountMinor.toString(),
          currency: purchase.currency,
          recipientDisplayName: 'TipMe Pro',
        },
      };
    }
    const checkout = await this.find(reference);
    return {
      data: {
        amountMinor: checkout.chargeMinor.toString(),
        currency: checkout.currency,
        recipientDisplayName: checkout.recipientDisplayName,
      },
    };
  }

  @Post(':reference')
  async pay(
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(outcomeSchema))
    body: z.infer<typeof outcomeSchema>,
    @Req() request: Request,
  ): Promise<ApiDataResponse<{ returnUrl: string }>> {
    if (PRO_REFERENCE.test(reference))
      return this.payPro(reference, body, request);
    const checkout = await this.find(reference);
    // Only the first choice plays; a repeat (back button, double tap) just returns to the receipt.
    if (await this.provider.chooseScenario(reference, body.outcome)) {
      const plan = planScenario(body.outcome, {
        reference,
        attemptId: checkout.attemptId,
        amountMinor: checkout.chargeMinor,
        currency: checkout.currency,
        feeMinor: mockProviderFee(checkout.chargeMinor),
      });
      // The API's own listening socket, never the request's Host header.
      const local = request.socket.localAddress ?? '127.0.0.1';
      const host = local.includes(':') ? `[${local}]` : local;
      const deliver = (part: typeof plan) =>
        runScenario({
          plan: part,
          webhookUrl: `http://${host}:${request.socket.localPort}/v1/webhooks/mock`,
          secret: this.config.MOCK_PROVIDER_WEBHOOK_SECRET ?? '',
        });
      const settle = () => this.provider.settle(reference);
      if (body.outcome === 'pending-then-succeed') {
        // Return after the first message so the supporter sees "waiting"; the rest follows.
        await deliver(plan.slice(0, 1));
        void deliver(plan.slice(1))
          .then(settle)
          .catch(() =>
            this.logger.warn({ event: 'mock_checkout.delivery_failed' }),
          );
      } else {
        await deliver(plan);
        await settle();
      }
    }
    // No receipt token here: holding a provider reference must never be enough to read a receipt.
    // The tab that started the tip already keeps the token for this tip in its session.
    return { data: { returnUrl: `${this.webOrigin}/tip/${checkout.tipId}` } };
  }

  /**
   * Pays a pretend Pro checkout: the pretend partner settles first, then says so in a signed
   * webhook, which TipMe reads back (as it does Bachs'). Only the first choice plays.
   */
  private async payPro(
    reference: string,
    body: z.infer<typeof outcomeSchema>,
    request: Request,
  ): Promise<ApiDataResponse<{ returnUrl: string }>> {
    const purchase = await this.findPro(reference);
    const outcome = body.outcome === 'decline' ? 'decline' : 'succeed';
    if (await this.provider.chooseScenario(reference, outcome)) {
      await this.provider.markMethod(
        reference,
        body.method === 'bank_transfer' ? 'NGN_BANK_TRANSFER' : 'NGN_CARD',
      );
      await this.provider.settle(reference);
      const local = request.socket.localAddress ?? '127.0.0.1';
      const host = local.includes(':') ? `[${local}]` : local;
      await runScenario({
        plan: [
          {
            body: {
              id: `evt_${randomUUID()}`,
              type:
                outcome === 'decline' ? 'payment.failed' : 'payment.succeeded',
              data: {
                reference,
                amountMinor: purchase.amountMinor.toString(),
                currency: purchase.currency,
                feeMinor: mockProviderFee(purchase.amountMinor).toString(),
              },
            },
            signed: true,
            delayMs: 0,
          },
        ],
        webhookUrl: `http://${host}:${request.socket.localPort}/v1/webhooks/mock`,
        secret: this.config.MOCK_PROVIDER_WEBHOOK_SECRET ?? '',
      });
    }
    return { data: { returnUrl: `${this.webOrigin}/dashboard/settings#plan` } };
  }

  private async findPro(reference: string) {
    const purchaseId = await findProPurchaseByReference(this.database.db, {
      provider: 'mock',
      providerReference: reference,
      operationReference: null,
    });
    const purchase = purchaseId
      ? await myProPurchaseById(this.database.db, purchaseId)
      : null;
    if (!purchase) throw new NotFoundException();
    // Like an expired hosted session: an ended purchase can't be paid here.
    if (purchase.status !== 'PENDING') throw new NotFoundException();
    return purchase;
  }

  private async find(reference: string) {
    const checkout = REFERENCE.test(reference)
      ? await findCheckoutByReference(this.database.db, 'mock', reference)
      : null;
    if (!checkout) throw new NotFoundException();
    // Like a real provider's expired hosted session: an expired tip can never be paid afterwards.
    if (checkout.attemptStatus === 'EXPIRED')
      throw new OperationError('TIP_NOT_PAYABLE');
    return checkout;
  }
}
