import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  proPurchaseRequestSchema,
  type ApiDataResponse,
  type MyPro,
  type ProAutoRenew,
  type ProPurchase,
  type ProPurchaseRequest,
} from '@tipme/contracts';
import {
  buyProByCheckout,
  buyProFromBalance,
  prepareProAutoRenew,
  proAutoRenewState,
  turnOffProAutoRenew,
  type MailSealing,
  myProfileId,
  myProPurchase,
  myProState,
  pageHandleLower,
  type ProPurchaseView,
} from '@tipme/database';
import { liveCheckoutOpenFor } from '@tipme/payments';
import { z } from 'zod';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { PRO_CHECKOUT_TOKEN, type ProCheckout } from './pro-provider.js';

const idempotencyKeyPipe = new ZodValidationPipe(z.uuid());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const wire = (purchase: ProPurchaseView): ProPurchase => ({
  purchaseId: purchase.purchaseId,
  status: purchase.status,
  amountMinor: String(purchase.amountMinor),
  currency: purchase.currency,
  checkoutUrl: purchase.checkoutUrl,
  expiresAt: purchase.expiresAt?.toISOString() ?? null,
  paidAt: purchase.paidAt?.toISOString() ?? null,
});

/**
 * Paid Pro for the signed-in recipient (ADR-0015). The price and every status come from the
 * server; Pro comes only from the payment partner's confirmed payment, read back, never from the
 * page a payer returns to. Users only ever see "our payment partner".
 */
@Controller('v1/me/pro')
@UseGuards(SessionGuard, CsrfGuard)
export class ProController {
  private readonly webOrigin: string;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(PRO_CHECKOUT_TOKEN) private readonly checkout: ProCheckout,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
  ) {
    this.webOrigin = new URL(config.WEB_ORIGIN).origin;
  }

  /** Whether this copy lets this page buy: the switch, and live money's own gates. */
  private billingOpenFor(handle: string | null): boolean {
    if (!this.config.PRO_BILLING_ENABLED) return false;
    if (!this.checkout.live) return true;
    return handle !== null && liveCheckoutOpenFor(this.config, handle);
  }

  /** The pretend partner's page lives in the web app; a real one is the partner's own URL. */
  private absolute(purchase: ProPurchase): ProPurchase {
    return purchase.checkoutUrl?.startsWith('/')
      ? { ...purchase, checkoutUrl: `${this.webOrigin}${purchase.checkoutUrl}` }
      : purchase;
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async mine(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyPro>> {
    const profileId = await myProfileId(this.database.db, auth.userId);
    const state = await myProState(this.database.db, profileId);
    const handle = await this.handleOf(profileId);
    return {
      data: {
        plan: state.plan,
        source: state.staffPro ? 'staff' : state.current ? 'paid' : null,
        current: state.current
          ? {
              startsAt: state.current.startsAt.toISOString(),
              endsAt: state.current.endsAt.toISOString(),
              graceEndsAt: state.current.graceEndsAt.toISOString(),
              paidBy: state.current.paidBy as NonNullable<
                MyPro['current']
              >['paidBy'],
            }
          : null,
        next: state.next
          ? {
              startsAt: state.next.startsAt.toISOString(),
              endsAt: state.next.endsAt.toISOString(),
            }
          : null,
        openPurchase: state.openPurchase
          ? this.absolute(wire(state.openPurchase))
          : null,
        price: state.price
          ? {
              amountMinor: String(state.price.amountMinor),
              currency: 'NGN',
              interval: 'month',
            }
          : null,
        // Paying from the TipMe balance waits on the partner's answer (plan Task 8; ruling 8).
        methods: this.config.PRO_PAY_FROM_BALANCE
          ? ['card', 'balance']
          : ['card'],
        billingOn: this.billingOpenFor(handle),
        autoRenew: {
          available: this.config.PRO_AUTO_RENEW,
          on:
            this.config.PRO_AUTO_RENEW &&
            (await proAutoRenewState(this.database.db, profileId)).on,
        },
      },
    };
  }

  /** "Turn off auto-renew" (plan Task 10): always allowed, even with the switch off. */
  @Post('auto-renew/off')
  @HttpCode(200)
  async autoRenewOff(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<ProAutoRenew>> {
    const profileId = await myProfileId(this.database.db, auth.userId);
    const state = await turnOffProAutoRenew(this.database.db, {
      profileId,
      now: new Date(),
    });
    return { data: { on: state.on } };
  }

  @Post('purchases')
  @HttpCode(201)
  async buy(
    @CurrentUser() auth: AuthContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(proPurchaseRequestSchema))
    body: ProPurchaseRequest,
  ): Promise<ApiDataResponse<ProPurchase>> {
    const key = idempotencyKeyPipe.transform(idempotencyKey, {
      type: 'custom',
      data: 'idempotency-key',
    });
    const profileId = await myProfileId(this.database.db, auth.userId);
    if (!this.billingOpenFor(await this.handleOf(profileId)))
      throw new CodedHttpException(404, 'PRO_BILLING_OFF');
    const expectedAmountMinor = BigInt(body.expectedAmountMinor);
    if (body.method === 'balance') {
      // Off: as if the way to pay didn't exist (ruling 8).
      if (!this.config.PRO_PAY_FROM_BALANCE || body.autoRenew)
        throw new CodedHttpException(400, 'VALIDATION_FAILED');
      const bought = await buyProFromBalance(this.database.db, {
        profileId,
        expectedAmountMinor,
        idempotencyKey: key,
        provider: this.checkout.money,
        providerName: this.checkout.adapterName,
        sealing: this.sealing,
        now: new Date(),
      });
      return { data: wire(bought) };
    }
    if (body.autoRenew && !this.config.PRO_AUTO_RENEW)
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    const settings = `${this.webOrigin}/dashboard/settings#plan`;
    const customerReference = body.autoRenew
      ? await prepareProAutoRenew(this.database.db, {
          profileId,
          provider: this.checkout.money,
          providerName: this.checkout.name,
        })
      : null;
    const bought = await buyProByCheckout(this.database.db, {
      profileId,
      expectedAmountMinor,
      idempotencyKey: key,
      provider: this.checkout.provider,
      providerName: this.checkout.name,
      successUrl: settings,
      cancelUrl: settings,
      ...(customerReference ? { saveCard: { customerReference } } : {}),
      now: new Date(),
    });
    return { data: this.absolute(wire(bought)) };
  }

  @Get('purchases/:purchaseId')
  @Header('Cache-Control', 'private, no-store')
  async purchase(
    @CurrentUser() auth: AuthContext,
    @Param('purchaseId') purchaseId: string,
  ): Promise<ApiDataResponse<ProPurchase>> {
    if (!UUID.test(purchaseId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const profileId = await myProfileId(this.database.db, auth.userId);
    const found = await myProPurchase(this.database.db, {
      profileId,
      purchaseId,
    });
    if (!found) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: this.absolute(wire(found)) };
  }

  private handleOf(profileId: string): Promise<string | null> {
    return pageHandleLower(this.database.db, profileId);
  }
}
