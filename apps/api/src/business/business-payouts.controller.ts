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
  Put,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiDataResponse,
  BusinessBalance,
  BusinessPayoutAccountStart,
  BusinessPayoutAccountState,
  PayoutBank,
  PayoutBankResolveRequest,
  PayoutBankResolveResponse,
  PayoutDestinationState,
  PayoutDestinationUpdateRequest,
  PayoutDestinationView,
  WithdrawalQuoteResponse,
} from '@tipme/contracts';
import {
  payoutBankResolveSchema,
  payoutDestinationUpdateSchema,
  recordedProviderName,
  withdrawalRequestSchema,
} from '@tipme/contracts';
import {
  businessBalanceOf,
  businessPaymentAccount,
  businessShareMoney,
  claimBusinessPaymentAccount,
  recordBusinessPaymentAccount,
  businessWithdrawalQuote,
  getPayoutDestination,
  managerOf,
  OperationError,
  payoutBankChangesFrom,
  requestBusinessWithdrawal,
  requestPayoutDestinationCode,
  safeError,
  setPayoutDestination,
  spendPayoutDestinationCode,
  withdrawalInReview,
  type MailSealing,
  type PayoutReader,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { BUSINESS_MIN_WITHDRAWAL_MINOR } from '@tipme/domain';
import {
  BachsApiError,
  type BachsProvider,
  type PayoutPort,
} from '@tipme/payments';
import { z } from 'zod';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import {
  BACHS_PROVIDER_TOKEN,
  WITHDRAWAL_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  PARTNER_QUOTE_CACHE,
  type RedisPartnerQuoteCache,
} from '../infra/partner-quote-cache.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { LOGGER } from '../tokens.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { SharesEnabledGuard } from './release2-flags.guard.js';

const idempotencyKeyPipe = new ZodValidationPipe(z.uuid());

// As the person's bank screen: the list rarely changes, and each read shares the payout rate limit.
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;

type WithdrawalProvider = PayoutReader &
  Pick<
    PayoutPort,
    | 'listBanks'
    | 'resolveBankAccount'
    | 'addPayoutDestination'
    | 'payoutDestinationStatus'
  >;

/**
 * Business release 2, PR R2-B: a business's own balance (its share of tips), its bank, and its
 * withdrawals, for its owners only. Everything goes through the person's balance-based path in
 * `@tipme/database` (same states, idempotency, holds, switch and partner calls). A location
 * manager, a former owner or anyone else gets 404, as for an unknown business: they see nothing of
 * the money. Behind `BUSINESS_ENABLED` and `BUSINESS_SHARES_ENABLED`, since only shares fill it.
 *
 * The full account number passes through to our payment partner and is never stored or logged.
 */
@Controller('v1/me/businesses/:businessId')
@UseGuards(BusinessEnabledGuard, SharesEnabledGuard, SessionGuard, CsrfGuard)
export class BusinessPayoutsController {
  private banksCache: { banks: PayoutBank[]; at: number } | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(WITHDRAWAL_PROVIDER_TOKEN)
    private readonly provider: WithdrawalProvider,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(PARTNER_QUOTE_CACHE)
    private readonly partnerCache: RedisPartnerQuoteCache,
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly bachs: BachsProvider | null,
  ) {}

  @Get('balance')
  @Header('Cache-Control', 'private, no-store')
  async balance(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
  ): Promise<ApiDataResponse<BusinessBalance>> {
    await this.owner(auth, businessId);
    const [{ availableMinor }, money, payoutAccount] = await Promise.all([
      businessBalanceOf(this.database.db, businessId),
      businessShareMoney(this.database.db, businessId),
      this.payoutAccountState(businessId),
    ]);
    return {
      data: {
        businessId,
        currency: 'NGN',
        balanceMinor: availableMinor.toString(),
        canWithdraw: availableMinor > 0n,
        onTheWayMinor: money.onTheWayMinor.toString(),
        heldBackMinor: money.heldBackMinor.toString(),
        minWithdrawalMinor: BUSINESS_MIN_WITHDRAWAL_MINOR.toString(),
        payoutAccount,
      },
    };
  }

  /**
   * Option B: sets up the business's own receive-only account with our payment partner (payouts
   * and transfers only; no card payments, so no selfie check or review). Safe to repeat: the
   * account is claimed first and made once. Answers the partner's page when it asks for the
   * business's registered name; the bank is then added below as for a person.
   */
  @Post('payout-account')
  @HttpCode(200)
  @RateLimit('intents')
  async setUpPayoutAccount(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
  ): Promise<ApiDataResponse<BusinessPayoutAccountStart>> {
    await this.owner(auth, businessId);
    const bachs = this.liveAccounts();
    if (!bachs) return { data: { payoutAccount: 'not_needed' } };
    const where = {
      businessId,
      provider: 'bachs',
      environment: bachs.environment,
    };
    const claim = await this.ownerOnly(() =>
      claimBusinessPaymentAccount(this.database.db, {
        ...where,
        userId: auth.userId,
      }),
    );
    let reference = claim.account.providerAccountReference;
    // A lost answer is asked again with the SAME key: our partner answers the same account, so a
    // business never gets two.
    if (claim.created || !reference) {
      if (!claim.contactEmail)
        throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
      try {
        const made = await bachs.createReceiveOnlyAccount({
          contactEmail: claim.contactEmail,
          country: 'NG',
          displayName: claim.businessName,
          idempotencyKey: `tipme-biz-acct-${claim.account.id}`,
        });
        reference = made.accountReference;
        if (made.holdsLocalCurrency === false)
          await bachs
            .holdLocalCurrency(reference)
            .catch((error: unknown) =>
              this.logFailure('local_currency', error),
            );
      } catch (error) {
        this.logFailure('create_account', error);
        await recordBusinessPaymentAccount(this.database.db, {
          ...where,
          status: error instanceof BachsApiError ? 'FAILED' : 'UNKNOWN',
        });
        throw new CodedHttpException(
          503,
          error instanceof BachsApiError
            ? 'DEPENDENCY_UNAVAILABLE'
            : 'PROVIDER_OUTCOME_UNKNOWN',
        );
      }
    }
    if (!reference)
      throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
    const account = await this.syncAccount(businessId, reference, true);
    const payoutAccount = this.stateOf(account.status);
    if (payoutAccount === 'ready') return { data: { payoutAccount } };
    const page = new URL(
      `/dashboard/business?business=${encodeURIComponent(businessId)}#money`,
      this.config.WEB_ORIGIN,
    ).toString();
    const onboardingUrl = await this.calling('onboarding_link', () =>
      bachs.createOnboardingLink({
        accountReference: reference!,
        refreshUrl: page,
        returnUrl: page,
      }),
    );
    return { data: { payoutAccount, onboardingUrl } };
  }

  /** One partner read per visit at most, through the shared quote cache (#118). */
  @Get('withdrawal-quote')
  @Header('Cache-Control', 'private, no-store')
  async quote(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
  ): Promise<ApiDataResponse<WithdrawalQuoteResponse>> {
    await this.owner(auth, businessId);
    const [quote, inReview] = await Promise.all([
      businessWithdrawalQuote(this.database.db, {
        businessId,
        provider: this.provider,
        onReadFailure: this.logReadFailure('quote'),
        cache: this.partnerCache,
      }),
      withdrawalInReview(this.database.db, { businessId }),
    ]);
    return {
      data:
        quote.state === 'ready'
          ? {
              ...quote,
              inReview,
              withdrawableMinor: quote.withdrawableMinor.toString(),
              ledgerMinor: quote.ledgerMinor.toString(),
              providerMinor: quote.providerMinor.toString(),
              feeMinor: quote.feeMinor.toString(),
              feePaidBy: quote.feePaidBy,
            }
          : { ...quote, inReview },
    };
  }

  /** Recorded and queued here; the worker starts the payout. Never retried by TipMe. */
  @Post('withdrawals')
  async withdraw(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(withdrawalRequestSchema))
    body: z.infer<typeof withdrawalRequestSchema>,
  ): Promise<ApiDataResponse<{ payoutId: string; status: string }>> {
    const key = idempotencyKeyPipe.transform(idempotencyKey, {
      type: 'custom',
      data: 'idempotency-key',
    });
    await this.owner(auth, businessId);
    const scope = { provider: this.provider.name, businessId };
    await this.partnerCache.invalidate(scope);
    try {
      const result = await this.ownerOnly(() =>
        requestBusinessWithdrawal(this.database.db, {
          businessId,
          userId: auth.userId,
          amountMinor: BigInt(body.amountMinor),
          idempotencyKey: key,
          provider: this.provider,
          onReadFailure: this.logReadFailure('request'),
        }),
      );
      return { data: { payoutId: result.payoutId, status: result.status } };
    } finally {
      await this.partnerCache.invalidate(scope);
    }
  }

  @Get('payout-destination')
  @Header('Cache-Control', 'no-store')
  async destination(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
  ): Promise<ApiDataResponse<PayoutDestinationState>> {
    await this.owner(auth, businessId);
    const changesFrom = await payoutBankChangesFrom(this.database.db, {
      userId: auth.userId,
    });
    return {
      data: {
        destination: await this.view(businessId),
        bankChangesFrom: changesFrom?.toISOString() ?? null,
      },
    };
  }

  @Post('payout-destination/resolve')
  @HttpCode(200)
  @RateLimit('bank_resolve')
  async resolve(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
    @Body(new ZodValidationPipe(payoutBankResolveSchema))
    body: PayoutBankResolveRequest,
  ): Promise<ApiDataResponse<PayoutBankResolveResponse>> {
    await this.owner(auth, businessId);
    if (!(await this.accountReference(businessId)))
      throw new CodedHttpException(409, 'PAYOUT_SETUP_NEEDED');
    const resolved = await this.calling('resolve', () =>
      this.provider.resolveBankAccount(body),
    );
    return {
      data: resolved
        ? { resolved: true, accountName: resolved.accountName }
        : { resolved: false },
    };
  }

  /** The code goes to the acting owner's own verified address, as for a person's bank. */
  @Post('payout-destination/code')
  @HttpCode(202)
  @RateLimit('auth_code')
  async code(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    await this.owner(auth, businessId);
    const { status } = await requestPayoutDestinationCode(
      this.database.db,
      this.sealing,
      { userId: auth.userId, secret: this.config.AUTH_CODE_SECRET },
    );
    if (status === 'no_email')
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    if (status === 'held')
      throw new CodedHttpException(409, 'BANK_CHANGE_HELD');
    if (status === 'rate_limited')
      throw new CodedHttpException(429, 'TOO_MANY_CODES');
    if (status === 'locked')
      throw new CodedHttpException(429, 'SIGN_IN_LOCKED');
    return { data: { sent: true } };
  }

  @Put('payout-destination')
  @RateLimit('auth_verify')
  async update(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
    @Body(new ZodValidationPipe(payoutDestinationUpdateSchema))
    body: PayoutDestinationUpdateRequest,
  ): Promise<ApiDataResponse<PayoutDestinationView | null>> {
    await this.owner(auth, businessId);
    // Everything that can be refused without spending the code is refused first.
    const reference = await this.accountReference(businessId);
    if (!reference) throw new CodedHttpException(409, 'PAYOUT_SETUP_NEEDED');
    const bank = (await this.listBanks()).find(
      ({ code }) => code === body.bankCode,
    );
    if (!bank) throw new CodedHttpException(400, 'PAYOUT_DESTINATION_REFUSED');
    const checked = await spendPayoutDestinationCode(this.database.db, {
      userId: auth.userId,
      code: body.emailCode,
      secret: this.config.AUTH_CODE_SECRET,
    });
    if (checked === 'locked')
      throw new CodedHttpException(429, 'SIGN_IN_LOCKED');
    if (checked === 'no_email')
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    if (checked === 'held')
      throw new CodedHttpException(409, 'BANK_CHANGE_HELD');
    if (checked !== 'ok') throw new CodedHttpException(400, 'CODE_INVALID');

    const added = await this.calling('add', () =>
      this.provider.addPayoutDestination(reference, {
        accountNumber: body.accountNumber,
        accountName: body.accountName,
        bankCode: body.bankCode,
      }),
    );
    // As the person's: the add's answer may be a replay, so only a status read decides.
    let status: PayoutDestinationView['status'] = 'pending_review';
    try {
      status = await this.provider.payoutDestinationStatus(
        reference,
        added.destinationRef,
      );
    } catch (error) {
      this.logFailure('read', error);
    }
    await this.ownerOnly(() =>
      setPayoutDestination(this.database.db, {
        sealing: this.sealing,
        businessId,
        userId: auth.userId,
        provider: recordedProviderName(this.provider.name),
        destinationRef: added.destinationRef,
        bankCode: bank.code,
        bankName: bank.name,
        last4: body.accountNumber.slice(-4),
        status,
      }),
    );
    await this.partnerCache.invalidate({
      provider: this.provider.name,
      businessId,
    });
    // A bank in the business's name is what live asks for: the account may now be ready.
    if (this.liveAccounts())
      await this.syncAccount(businessId, reference, false).catch(
        (error: unknown) => this.logFailure('sync_account', error),
      );
    return { data: await this.view(businessId) };
  }

  /** Owners only. Anyone else reads exactly like an unknown business (404), as the plan says. */
  private owner(auth: AuthContext, businessId: string): Promise<unknown> {
    return this.ownerOnly(() =>
      managerOf(this.database.db, auth.userId, businessId, { owner: true }),
    );
  }

  /** A location manager's OWNER_REQUIRED is a 404 here: they see nothing of the money. */
  private async ownerOnly<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof OperationError && error.code === 'OWNER_REQUIRED')
        throw new OperationError('NOT_A_MANAGER');
      throw error;
    }
  }

  /**
   * The account a business's bank hangs from. The pretend provider has no accounts, so the business
   * stands in, as a profile does for a person. With our live partner (option B) it is the
   * business's own receive-only account, once set up above; until then PAYOUT_SETUP_NEEDED.
   */
  private async accountReference(businessId: string): Promise<string | null> {
    if (this.provider.capabilities?.connectedAccounts === false)
      return businessId;
    const bachs = this.liveAccounts();
    if (!bachs) return null;
    const account = await businessPaymentAccount(this.database.db, {
      businessId,
      provider: 'bachs',
      environment: bachs.environment,
    });
    return account?.providerAccountReference ?? null;
  }

  /** The partner adapter that can make accounts, when this copy talks to one. */
  private liveAccounts(): BachsProvider | null {
    if (this.provider.capabilities?.connectedAccounts === false) return null;
    return this.bachs;
  }

  private stateOf(status: string | undefined): BusinessPayoutAccountState {
    if (status === undefined) return 'needed';
    if (status === 'ACTIVE') return 'ready';
    if (status === 'FAILED') return 'needed';
    return 'setting_up';
  }

  /** Reads the account's state from TipMe's records; re-asks our partner while it is setting up. */
  private async payoutAccountState(
    businessId: string,
  ): Promise<BusinessPayoutAccountState> {
    const bachs = this.liveAccounts();
    if (!bachs) return 'not_needed';
    const account = await businessPaymentAccount(this.database.db, {
      businessId,
      provider: 'bachs',
      environment: bachs.environment,
    });
    if (!account) return 'needed';
    if (account.status === 'ACTIVE' || !account.providerAccountReference)
      return this.stateOf(account.status);
    try {
      return this.stateOf(
        (
          await this.syncAccount(
            businessId,
            account.providerAccountReference,
            false,
          )
        ).status,
      );
    } catch (error) {
      this.logFailure('sync_account', error);
      return this.stateOf(account.status);
    }
  }

  /**
   * Payouts become TipMe's to make (manual), then the account's payout and transfer capabilities
   * decide whether it is ready. Both calls are safe to repeat.
   */
  private async syncAccount(
    businessId: string,
    reference: string,
    setManual: boolean,
  ) {
    const bachs = this.liveAccounts()!;
    const where = {
      businessId,
      provider: 'bachs',
      environment: bachs.environment,
    };
    const current = await businessPaymentAccount(this.database.db, where);
    let manual = current?.manualPayouts ?? false;
    if (!manual && setManual) {
      await this.calling('manual_payouts', () =>
        bachs.setManualPayouts(reference),
      );
      manual = true;
    }
    const capability = await this.calling('capability', () =>
      bachs.payoutCapability(reference),
    );
    return recordBusinessPaymentAccount(this.database.db, {
      ...where,
      providerAccountReference: reference,
      status:
        capability.status === 'active'
          ? 'ACTIVE'
          : capability.status === 'restricted'
            ? 'RESTRICTED'
            : 'ONBOARDING',
      requirementsDue: capability.requirementsDue,
      manualPayouts: manual,
    });
  }

  private async view(
    businessId: string,
  ): Promise<PayoutDestinationView | null> {
    const current = await getPayoutDestination(this.database.db, {
      businessId,
      provider: recordedProviderName(this.provider.name),
    });
    return (
      current && {
        status: current.status,
        bankName: current.bankName,
        last4: current.last4,
      }
    );
  }

  private async listBanks(): Promise<PayoutBank[]> {
    const now = Date.now();
    if (this.banksCache && now - this.banksCache.at < BANK_LIST_TTL_MS)
      return this.banksCache.banks;
    const banks = await this.calling('banks', () =>
      this.provider.listBanks('NG'),
    );
    if (banks.length > 0) this.banksCache = { banks, at: now };
    return banks;
  }

  /** Any partner failure here is "unavailable": no payout is involved, so nothing is retried. */
  private async calling<T>(step: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.logFailure(step, error);
      throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
    }
  }

  private logReadFailure(during: 'quote' | 'request') {
    return (failure: ReturnType<typeof safeError>) =>
      this.logger.warn({
        event: 'business_withdrawal.provider_read_failed',
        during,
        provider: this.provider.name,
        ...failure,
      });
  }

  // The error's type only: a partner message could repeat what it was sent.
  private logFailure(step: string, error: unknown): void {
    this.logger.warn({
      event: 'business_payout_destination.provider_failed',
      step,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
