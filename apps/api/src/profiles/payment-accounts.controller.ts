import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiDataResponse,
  BachsOnboardingRequest,
  BachsOnboardingResponse,
  BachsPaymentAccountStatus,
} from '@tipme/contracts';
import { bachsOnboardingRequestSchema } from '@tipme/contracts';
import {
  beginPaymentAccountCreation,
  getPaymentAccountForProfile,
  getPaymentAccountRecipient,
  markPaymentAccountCreationFailed,
  markPaymentAccountCreationUnknown,
  updatePaymentAccountStatus,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import {
  BachsApiError,
  type BachsRecipientAccount,
  type BachsProvider,
} from '@tipme/payments';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { BACHS_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { LOGGER } from '../tokens.js';

@Controller('v1/me/payment-account')
@UseGuards(SessionGuard, CsrfGuard)
export class PaymentAccountsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly provider: BachsProvider | null,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  async status(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<BachsPaymentAccountStatus>> {
    if (!this.isEnabled())
      return {
        data: {
          enabled: false,
          environment: null,
          status: null,
          chargesEnabled: false,
          payoutsEnabled: false,
          feeCollector: null,
          requirementsDue: [],
          lastSyncedAt: null,
        },
      };

    const recipient = await this.recipient(auth.userId);
    const account = await getPaymentAccountForProfile(this.database.db, {
      profileId: recipient.profileId,
      provider: 'bachs',
      environment: 'sandbox',
    });
    const feeCollector =
      account?.feeCollector === 'platform' ||
      account?.feeCollector === 'connected_account' ||
      account?.feeCollector === 'unknown'
        ? account.feeCollector
        : null;
    return {
      data: {
        enabled: true,
        environment: 'sandbox',
        status: account?.status ?? null,
        chargesEnabled: account?.chargesEnabled ?? false,
        payoutsEnabled: account?.payoutsEnabled ?? false,
        feeCollector,
        requirementsDue: account?.requirementsDue ?? [],
        lastSyncedAt: account?.lastSyncedAt?.toISOString() ?? null,
      },
    };
  }

  @Post('onboarding')
  @HttpCode(200)
  @RateLimit('intents')
  async onboard(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(bachsOnboardingRequestSchema))
    body: BachsOnboardingRequest,
  ): Promise<ApiDataResponse<BachsOnboardingResponse>> {
    if (!this.isEnabled() || !this.provider)
      throw new CodedHttpException(404, 'NOT_FOUND');

    const recipient = await this.recipient(auth.userId);
    if (!recipient.verifiedEmail)
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');

    const claim = await beginPaymentAccountCreation(this.database.db, {
      profileId: recipient.profileId,
      provider: 'bachs',
      environment: 'sandbox',
    });
    if (!claim.created && !claim.account.providerAccountReference) {
      if (claim.account.status === 'UNKNOWN')
        throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
      if (claim.account.status === 'CREATING')
        throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    }

    let remoteAccount: BachsRecipientAccount;
    if (claim.created) {
      try {
        remoteAccount = await this.provider.createRecipientAccount({
          contactEmail: recipient.verifiedEmail,
          country: body.country,
          displayName: recipient.displayName,
          entityType: body.entityType,
          idempotencyKey: `tipme-acct-${claim.account.id}`,
        });
      } catch (error) {
        if (error instanceof BachsApiError) {
          await markPaymentAccountCreationFailed(this.database.db, {
            profileId: recipient.profileId,
            provider: 'bachs',
            environment: 'sandbox',
          });
          this.logger.warn({
            event: 'payment_account.creation_rejected',
            provider: 'bachs',
            error: error.name,
          });
          throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
        }
        await markPaymentAccountCreationUnknown(this.database.db, {
          profileId: recipient.profileId,
          provider: 'bachs',
          environment: 'sandbox',
        });
        this.logger.warn({
          event: 'payment_account.creation_unknown',
          provider: 'bachs',
          error: error instanceof Error ? error.name : typeof error,
        });
        throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
      }
    } else {
      const accountReference = claim.account.providerAccountReference;
      if (!accountReference)
        throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
      try {
        remoteAccount =
          await this.provider.getRecipientAccount(accountReference);
      } catch (error) {
        this.logger.warn({
          event: 'payment_account.sync_failed',
          provider: 'bachs',
          error: error instanceof Error ? error.name : typeof error,
        });
        throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
      }
    }

    const chargesEnabled =
      remoteAccount.active === true &&
      remoteAccount.ngnCardCollectionStatus === 'active';
    const account = await updatePaymentAccountStatus(this.database.db, {
      profileId: recipient.profileId,
      provider: 'bachs',
      environment: 'sandbox',
      providerAccountReference: remoteAccount.accountReference,
      status: chargesEnabled ? 'ACTIVE' : 'ONBOARDING',
      chargesEnabled,
      payoutsEnabled: false,
      feeCollector: 'platform',
      requirementsDue: remoteAccount.requirementsDue,
    });
    if (account.status === 'ACTIVE')
      return { data: { status: 'ACTIVE', chargesEnabled: true } };
    if (account.status !== 'ONBOARDING' && account.status !== 'RESTRICTED')
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');

    const page = new URL(
      '/dashboard/settings?payment-account=return',
      this.config.WEB_ORIGIN,
    );
    let onboardingUrl: string;
    try {
      onboardingUrl = await this.provider.createOnboardingLink({
        accountReference: remoteAccount.accountReference,
        refreshUrl: page.toString(),
        returnUrl: page.toString(),
      });
    } catch (error) {
      this.logger.warn({
        event: 'payment_account.onboarding_link_failed',
        provider: 'bachs',
        error: error instanceof Error ? error.name : typeof error,
      });
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    }
    return {
      data: {
        status: account.status,
        onboardingUrl,
        requirementsDue: account.requirementsDue,
      },
    };
  }

  private isEnabled(): boolean {
    return this.config.PAYMENT_PROVIDER === 'bachs-sandbox';
  }

  private async recipient(userId: string) {
    const recipient = await getPaymentAccountRecipient(
      this.database.db,
      userId,
    );
    if (!recipient) throw new CodedHttpException(404, 'NOT_FOUND');
    return recipient;
  }
}
