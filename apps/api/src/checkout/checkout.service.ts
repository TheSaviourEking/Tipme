import { Inject, Injectable } from '@nestjs/common';
import type {
  TipIntentCreated,
  TipIntentRequest,
  TipQuote,
  TipQuoteRequest,
} from '@tipme/contracts';
import {
  createPaymentIntent,
  createQuote,
  findAttemptStart,
  findQuoteCharge,
  markAttemptInitiated,
  OperationError,
} from '@tipme/database';
import type { MockProvider } from '@tipme/payments';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { PAYMENT_PROVIDER_TOKEN } from './payment-provider.provider.js';
import { createStatusToken } from './status-token.js';

/** Guest checkout through the PR-005 operations; prices and fees only ever come from the server. */
@Injectable()
export class CheckoutService {
  private readonly webOrigin: string;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly provider: MockProvider,
  ) {
    this.webOrigin = new URL(config.WEB_ORIGIN).origin;
  }

  async quote(request: TipQuoteRequest): Promise<TipQuote> {
    const result = await createQuote(this.database.db, {
      handle: request.handle,
      tipMinor: BigInt(request.amountMinor),
      currency: request.currency,
    });
    const { breakdown } = result;
    return {
      quoteId: result.quoteId,
      handle: result.handle,
      displayName: result.displayName,
      currency: result.currency,
      tipMinor: breakdown.tipMinor.toString(),
      platformFeeMinor: breakdown.platformFeeMinor.toString(),
      providerFeeMinor: breakdown.providerFeeMinor.toString(),
      recipientNetMinor: breakdown.recipientNetMinor.toString(),
      payerTotalMinor: breakdown.payerTotalMinor.toString(),
      expiresAt: result.expiresAt.toISOString(),
      feePolicyVersion: result.feePolicyVersion,
      feeFree: result.feeFree,
    };
  }

  /**
   * Creates (or replays) the tip and starts its payment once. A replay that races the first request,
   * or follows one that failed before reaching the provider, may start the payment itself:
   * markAttemptInitiated lets exactly one reference win, and every response carries the winner.
   */
  async createIntent(
    request: TipIntentRequest,
    idempotencyKey: string,
  ): Promise<TipIntentCreated> {
    const { db } = this.database;
    const intent = await createPaymentIntent(db, {
      quoteId: request.quoteId,
      idempotencyKey,
      message: request.message,
      payerDisplayLabel: request.payerDisplayLabel,
      purpose: request.purpose,
      celebrationMomentId: request.celebrationMomentId,
    });
    const start = await findAttemptStart(db, intent.attemptId);
    let reference = start?.reference ?? null;
    // Never started and no longer startable (e.g. expired): nothing to pay, and nothing to ask.
    if (!reference && start?.status !== 'CREATED')
      throw new OperationError('TIP_NOT_PAYABLE');
    if (!reference) {
      const quote = await findQuoteCharge(db, request.quoteId);
      if (!quote) throw new OperationError('QUOTE_NOT_FOUND');
      const started = await this.provider.initializePayment({
        attemptId: intent.attemptId,
        amountMinor: quote.payerTotalMinor,
        currency: quote.currency,
      });
      const outcome = await markAttemptInitiated(db, {
        attemptId: intent.attemptId,
        provider: this.provider.name,
        providerReference: started.providerReference,
      });
      reference =
        outcome === 'initiated'
          ? started.providerReference
          : ((await findAttemptStart(db, intent.attemptId))?.reference ?? null);
      if (!reference) throw new OperationError('ATTEMPT_NOT_FOUND');
    }
    return {
      tipId: intent.tipId,
      statusToken: createStatusToken(
        this.config.STATUS_TOKEN_SECRET,
        intent.tipId,
      ),
      checkoutUrl: `${this.webOrigin}/mock-checkout/${encodeURIComponent(reference)}`,
    };
  }
}
