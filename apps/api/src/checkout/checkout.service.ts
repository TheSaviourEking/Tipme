import { Inject, Injectable } from '@nestjs/common';
import type {
  TipIntentCreated,
  TipIntentRequest,
  TipQuote,
  TipQuoteRequest,
} from '@tipme/contracts';
import {
  claimAttemptStart,
  createPaymentIntent,
  createQuote,
  findAttemptStart,
  findQuoteCharge,
  getReadyPaymentAccount,
  markAttemptStartFailed,
  markAttemptUnknown,
  markAttemptInitiated,
  OperationError,
} from '@tipme/database';
import {
  BachsApiError,
  UncertainProviderOutcomeError,
  type BachsProvider,
  type MockProvider,
} from '@tipme/payments';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import {
  BACHS_PROVIDER_TOKEN,
  CHECKOUT_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
  type CheckoutPaymentProvider,
} from './payment-provider.provider.js';
import { createStatusToken } from './status-token.js';

/** Guest checkout through the PR-005 operations; prices and fees only ever come from the server. */
/**
 * Whether a failed Bachs checkout start is a definite refusal (nothing was created, so the
 * attempt can fail) or ambiguous (the checkout may exist, so it stays UNKNOWN and is never
 * retried). Only allowlisted fields go into diagnostics: never messages, bodies or PII.
 */
export function classifyBachsStartError(error: unknown): {
  outcome: 'failed' | 'unknown';
  diagnostic: Record<string, string | number>;
} {
  // A 4xx is a refusal; 408 (timeout) and 409 (conflict) may hide an accepted request.
  if (
    error instanceof BachsApiError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408 &&
    error.statusCode !== 409
  ) {
    return {
      outcome: 'failed',
      diagnostic: {
        error: error.name,
        provider_http_status: error.statusCode,
        ...(error.providerCode ? { provider_code: error.providerCode } : {}),
      },
    };
  }
  const cause =
    error instanceof UncertainProviderOutcomeError
      ? error.diagnostic
      : undefined;
  return {
    outcome: 'unknown',
    diagnostic: {
      error: error instanceof Error ? error.name : typeof error,
      ...(cause
        ? {
            reason: cause.cause,
            ...(cause.httpStatus === undefined
              ? {}
              : { provider_http_status: cause.httpStatus }),
            ...(cause.providerCode
              ? { provider_code: cause.providerCode }
              : {}),
          }
        : {}),
    },
  };
}

@Injectable()
export class CheckoutService {
  private readonly webOrigin: string;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(CHECKOUT_PROVIDER_TOKEN)
    private readonly defaultProvider: CheckoutPaymentProvider,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly mockProvider: MockProvider,
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly bachsProvider: BachsProvider | null,
    @Inject(LOGGER) private readonly logger: Logger,
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

  /** Creates or replays an intent, keeping external writes tied to one durable attempt claim. */
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
    if (!start) throw new OperationError('ATTEMPT_NOT_FOUND');
    const providerName = start.provider ?? this.defaultProvider.name;

    if (start.reference)
      return this.intentResponse(
        intent.tipId,
        await this.checkoutUrl(providerName, start.reference),
      );

    if (start.status !== 'CREATED') {
      if (start.status === 'STARTING' || start.status === 'UNKNOWN')
        throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
      throw new OperationError('TIP_NOT_PAYABLE');
    }

    const quote = await findQuoteCharge(db, request.quoteId);
    if (!quote) throw new OperationError('QUOTE_NOT_FOUND');

    if (providerName === 'bachs') {
      if (!this.bachsProvider)
        throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
      const accountReference = await getReadyPaymentAccount(db, {
        profileId: quote.profileId,
        provider: 'bachs',
        environment: 'sandbox',
      });
      if (!accountReference)
        throw new CodedHttpException(409, 'PAYMENT_ACCOUNT_REQUIRED');

      const claim = await claimAttemptStart(db, {
        attemptId: intent.attemptId,
        provider: 'bachs',
      });
      if (claim.outcome !== 'claimed') {
        const current = await findAttemptStart(db, intent.attemptId);
        if (current?.reference)
          return this.intentResponse(
            intent.tipId,
            await this.checkoutUrl(
              current.provider ?? 'bachs',
              current.reference,
            ),
          );
        if (current?.status === 'STARTING' || current?.status === 'UNKNOWN') {
          throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
        }
        throw new OperationError('TIP_NOT_PAYABLE');
      }

      let started: Awaited<ReturnType<BachsProvider['initializePayment']>>;
      try {
        started = await this.bachsProvider.initializePayment({
          attemptId: intent.attemptId,
          amountMinor: quote.payerTotalMinor,
          currency: quote.currency,
          recipientAccountReference: accountReference,
          tipmeShareMinor: quote.platformFeeMinor + quote.providerFeeMinor,
          successUrl: new URL(
            `/tip/${intent.tipId}`,
            this.webOrigin,
          ).toString(),
          cancelUrl: new URL(`/tip/${intent.tipId}`, this.webOrigin).toString(),
          idempotencyKey: `tipme-checkout-${intent.attemptId}`,
        });
      } catch (error) {
        const { outcome, diagnostic } = classifyBachsStartError(error);
        if (outcome === 'failed') {
          await markAttemptStartFailed(db, {
            attemptId: intent.attemptId,
            provider: 'bachs',
          });
          this.logger.warn({
            event: 'payment.start_rejected',
            provider: 'bachs',
            attempt_id: intent.attemptId,
            ...diagnostic,
          });
          throw new CodedHttpException(502, 'PAYMENT_START_REJECTED');
        }
        await markAttemptUnknown(db, {
          attemptId: intent.attemptId,
          provider: 'bachs',
        });
        this.logger.warn({
          event: 'payment.start_unknown',
          provider: 'bachs',
          attempt_id: intent.attemptId,
          ...diagnostic,
        });
        const current = await findAttemptStart(db, intent.attemptId);
        if (current?.reference && current.provider === 'bachs')
          return this.intentResponse(
            intent.tipId,
            await this.checkoutUrl('bachs', current.reference),
          );
        throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
      }

      const outcome = await markAttemptInitiated(db, {
        attemptId: intent.attemptId,
        provider: 'bachs',
        providerReference: started.providerReference,
      });
      if (outcome !== 'initiated' && outcome !== 'already') {
        const current = await findAttemptStart(db, intent.attemptId);
        if (current?.reference && current.provider === 'bachs')
          return this.intentResponse(
            intent.tipId,
            await this.checkoutUrl('bachs', current.reference),
          );
        throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
      }
      const checkoutUrl =
        started.checkoutUrl ??
        (await this.bachsProvider.getCheckoutUrl(started.providerReference));
      return this.intentResponse(intent.tipId, checkoutUrl);
    }

    if (providerName !== 'mock')
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');

    const started = await this.mockProvider.initializePayment({
      attemptId: intent.attemptId,
      amountMinor: quote.payerTotalMinor,
      currency: quote.currency,
    });
    const outcome = await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'mock',
      providerReference: started.providerReference,
    });
    const reference =
      outcome === 'initiated'
        ? started.providerReference
        : ((await findAttemptStart(db, intent.attemptId))?.reference ?? null);
    if (!reference) throw new OperationError('ATTEMPT_NOT_FOUND');
    return this.intentResponse(
      intent.tipId,
      `${this.webOrigin}/mock-checkout/${encodeURIComponent(reference)}`,
    );
  }

  private async checkoutUrl(
    provider: string,
    reference: string,
  ): Promise<string> {
    if (provider === 'mock')
      return `${this.webOrigin}/mock-checkout/${encodeURIComponent(reference)}`;
    if (provider === 'bachs' && this.bachsProvider)
      return this.bachsProvider.getCheckoutUrl(reference);
    throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
  }

  private intentResponse(tipId: string, checkoutUrl: string): TipIntentCreated {
    return {
      tipId,
      statusToken: createStatusToken(this.config.STATUS_TOKEN_SECRET, tipId),
      checkoutUrl,
    };
  }
}
