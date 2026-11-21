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
  pageHandleOf,
  quoteHandleOf,
  findAttemptStart,
  findQuoteCharge,
  getReadyPaymentAccount,
  markAttemptStartFailed,
  markAttemptUnknown,
  markAttemptInitiated,
  OperationError,
  featureOn,
} from '@tipme/database';
import {
  BachsApiError,
  BachsRequestNotSentError,
  PlatformCheckoutUnavailableError,
  UncertainProviderOutcomeError,
  isLiveProvider,
  liveCheckoutOpenFor,
  recordedProviderName,
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
import { intentAddressKey } from './address-key.js';
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
  // Refused before it was sent: Bachs never saw it, so nothing can have started.
  if (error instanceof BachsRequestNotSentError)
    return { outcome: 'failed', diagnostic: { error: error.name } };
  // You collect: TipMe's own account definitely refused the checkout (not activated); none exists.
  if (error instanceof PlatformCheckoutUnavailableError)
    return {
      outcome: 'failed',
      diagnostic: {
        error: error.name,
        ...(error.providerCode ? { provider_code: error.providerCode } : {}),
      },
    };
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

  /**
   * A production copy may run Bachs live with checkout closed (switched off), or open only to named
   * pages (LIVE_CHECKOUT_HANDLES). Quotes and new tips are refused before any database write or
   * provider call. Webhooks and status checks for earlier activity are unaffected. mock and
   * bachs-sandbox never refuse for this reason. Unknown pages get the same answer as closed ones.
   */
  private async refuseWhileClosed(
    currentHandle: () => Promise<string | null>,
  ): Promise<void> {
    const { PAYMENT_PROVIDER, PAYMENTS_LIVE_ENABLED, LIVE_CHECKOUT_HANDLES } =
      this.config;
    if (!isLiveProvider(PAYMENT_PROVIDER)) return;
    if (PAYMENTS_LIVE_ENABLED && LIVE_CHECKOUT_HANDLES === '*') return;
    const handle = PAYMENTS_LIVE_ENABLED ? await currentHandle() : null;
    if (!handle || !liveCheckoutOpenFor(this.config, handle))
      throw new CodedHttpException(409, 'TIPPING_NOT_OPEN');
  }

  async quote(request: TipQuoteRequest): Promise<TipQuote> {
    await this.refuseWhileClosed(async () =>
      pageHandleOf(this.database.db, request.handle),
    );
    const sharesOn = request.businessMemberId ? await this.sharesOn() : false;
    // You collect (R7): read once per quote. On, an undecided recipient is decided against this
    // copy's partner accounts; off, the quote takes their mode as it stands.
    const youCollectOn = await featureOn(this.database.db, 'you_collect');
    const result = await createQuote(this.database.db, {
      handle: request.handle,
      tipMinor: BigInt(request.amountMinor),
      currency: request.currency,
      ...(sharesOn && request.businessMemberId
        ? { businessMemberId: request.businessMemberId, sharesOn: true }
        : {}),
      ...(youCollectOn
        ? {
            youCollectOn: true,
            provider: recordedProviderName(this.defaultProvider.name),
            environment: this.bachsProvider?.environment ?? 'sandbox',
          }
        : { youCollectOn: false }),
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
      ...(result.share
        ? {
            share: {
              businessPercent: result.share.businessBps / 100,
              personKeepsPercent: 100 - result.share.businessBps / 100,
              businessName: result.share.businessName,
            },
          }
        : {}),
      ...(result.collectionMode === 'collect'
        ? { collectedByTipMe: true as const }
        : {}),
    };
  }

  /** Business release 2: shares need both switches; off, nothing about a share is read or fixed. */
  private async sharesOn(): Promise<boolean> {
    const { db } = this.database;
    const [business, shares] = await Promise.all([
      featureOn(db, 'business'),
      featureOn(db, 'business_shares'),
    ]);
    return business && shares;
  }

  /** Creates or replays an intent, keeping external writes tied to one durable attempt claim. */
  async createIntent(
    request: TipIntentRequest,
    idempotencyKey: string,
    /** The supporter's address, as the rate limit sees it; stored only as a keyed hash. */
    ip?: string,
  ): Promise<TipIntentCreated> {
    await this.refuseWhileClosed(() =>
      quoteHandleOf(this.database.db, request.quoteId),
    );
    const { db } = this.database;
    const [recognitionOn, businessOn, sharesOn] = await Promise.all([
      featureOn(db, 'supporter_recognition'),
      featureOn(db, 'business'),
      featureOn(db, 'business_shares'),
    ]);
    // Keyed with the receipt-token secret under its own label (see intentAddressKey).
    const addressKey = intentAddressKey(this.config.STATUS_TOKEN_SECRET, ip);
    const intent = await createPaymentIntent(db, {
      quoteId: request.quoteId,
      idempotencyKey,
      message: request.message,
      payerDisplayLabel: request.payerDisplayLabel,
      purpose: request.purpose,
      celebrationMomentId: request.celebrationMomentId,
      noteMayShow: request.noteMayShow,
      supporterKey: request.supporterKey,
      recognitionOn,
      ...(addressKey ? { addressKey } : {}),
      // Campaign Studio: which campaign link the page was opened from; ignored when not one.
      ...(request.campaign ? { campaign: request.campaign } : {}),
      // With the business feature off, the label never reaches the database (plan, the flag).
      ...(businessOn && request.businessMemberId
        ? { businessMemberId: request.businessMemberId }
        : {}),
      ...(businessOn && sharesOn ? { sharesOn: true } : {}),
    });
    const start = await findAttemptStart(db, intent.attemptId);
    if (!start) throw new OperationError('ATTEMPT_NOT_FOUND');
    // Rows record 'bachs' for either environment; this copy's adapter is the one configured.
    const providerName =
      start.provider ?? recordedProviderName(this.defaultProvider.name);

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
      const bachs = this.bachsProvider;
      const successUrl = new URL(
        `/tip/${intent.tipId}`,
        this.webOrigin,
      ).toString();
      const cancelUrl = new URL(
        `/tip/${intent.tipId}`,
        this.webOrigin,
      ).toString();
      const idempotencyKey = `tipme-checkout-${intent.attemptId}`;
      // The mode fixed on the quote, never the person's mode now (plan, "mode is fixed per tip").
      const collect = quote.collectionMode === 'collect';
      let begin: () => Promise<{
        providerReference: string;
        checkoutUrl?: string;
      }>;
      if (collect) {
        // You collect: on TipMe's own account, so the recipient needs no partner account yet.
        const collectCheckout = bachs.initializeCollectCheckout?.bind(bachs);
        if (!collectCheckout)
          throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
        const currency = quote.currency;
        if (currency !== 'NGN') throw new OperationError('TIP_NOT_PAYABLE');
        begin = () =>
          collectCheckout({
            attemptId: intent.attemptId,
            amountMinor: quote.payerTotalMinor,
            currency,
            successUrl,
            cancelUrl,
            idempotencyKey,
          });
      } else {
        const accountReference = await getReadyPaymentAccount(db, {
          profileId: quote.profileId,
          provider: 'bachs',
          environment: bachs.environment,
        });
        if (!accountReference)
          throw new CodedHttpException(409, 'PAYMENT_ACCOUNT_REQUIRED');
        begin = () =>
          bachs.initializePayment({
            attemptId: intent.attemptId,
            amountMinor: quote.payerTotalMinor,
            currency: quote.currency,
            recipientAccountReference: accountReference,
            tipmeShareMinor: quote.platformFeeMinor + quote.providerFeeMinor,
            successUrl,
            cancelUrl,
            idempotencyKey,
          });
      }
      // Logged only for collect, so direct starts log exactly as before.
      const mode = collect ? { collection_mode: 'collect' } : {};

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

      // Started once per claimed attempt; an uncertain start stays UNKNOWN and is never retried here.
      let started: Awaited<ReturnType<typeof begin>>;
      try {
        started = await begin();
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
            ...mode,
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
          ...mode,
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
        (await bachs.getCheckoutUrl(started.providerReference));
      return this.intentResponse(intent.tipId, checkoutUrl);
    }

    if (providerName !== 'mock')
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');

    // You collect: the pretend provider's checkout on TipMe's own account (`platform:mock_collect_…`).
    let started: { providerReference: string };
    if (quote.collectionMode === 'collect') {
      const collectCheckout = this.mockProvider.initializeCollectCheckout?.bind(
        this.mockProvider,
      );
      const currency = quote.currency;
      if (!collectCheckout)
        throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
      if (currency !== 'NGN') throw new OperationError('TIP_NOT_PAYABLE');
      // A courtesy before the pretend provider is asked; markAttemptInitiated's check binds.
      if (quote.expiresAt.getTime() <= Date.now())
        throw new OperationError('QUOTE_EXPIRED');
      started = await collectCheckout({
        attemptId: intent.attemptId,
        amountMinor: quote.payerTotalMinor,
        currency,
        successUrl: new URL(`/tip/${intent.tipId}`, this.webOrigin).toString(),
        cancelUrl: new URL(`/tip/${intent.tipId}`, this.webOrigin).toString(),
        idempotencyKey: `tipme-checkout-${intent.attemptId}`,
      });
    } else {
      started = await this.mockProvider.initializePayment({
        attemptId: intent.attemptId,
        amountMinor: quote.payerTotalMinor,
        currency: quote.currency,
      });
    }
    // You collect (fix round 4): opening a checkout, so an expired collect quote is refused here
    // as the partner's claim refuses it. A direct tip is unaffected.
    const outcome = await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'mock',
      providerReference: started.providerReference,
      opensCheckout: true,
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
