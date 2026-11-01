import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiDataResponse,
  PayoutBank,
  PayoutBankResolveRequest,
  PayoutBankResolveResponse,
  PayoutDestinationState,
  PayoutDestinationUpdateRequest,
  PayoutDestinationView,
} from '@tipme/contracts';
import {
  payoutBankResolveSchema,
  payoutDestinationUpdateSchema,
  recordedProviderName,
} from '@tipme/contracts';
import {
  getBachsAccountRecoveryTarget,
  getPaymentAccountRecipient,
  getPayoutDestination,
  payoutBankChangesFrom,
  refreshPendingDestination,
  withdrawalsFrozen,
  requestPayoutDestinationCode,
  setPayoutDestination,
  spendPayoutDestinationCode,
  type MailSealing,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import {
  BachsApiError,
  bachsEnvironment,
  type PayoutPort,
} from '@tipme/payments';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { WITHDRAWAL_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { LOGGER } from '../tokens.js';

// Banks rarely change, and each read of the list is a provider call that shares a rate limit with
// payouts. A refused or new bank code is the provider's to answer, so a day's staleness is harmless.
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;

type DestinationProvider = Pick<
  PayoutPort,
  | 'listBanks'
  | 'resolveBankAccount'
  | 'addPayoutDestination'
  | 'payoutDestinationStatus'
> & {
  name: string;
  capabilities?: { connectedAccounts: boolean };
};

/**
 * The bank account a recipient is paid to. The full number passes through to the provider and is
 * never stored or logged; the recipient sees only the bank's name and the last four digits.
 */
@Controller('v1')
@UseGuards(SessionGuard, CsrfGuard)
export class PayoutDestinationController {
  private banksCache: { banks: PayoutBank[]; at: number } | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(WITHDRAWAL_PROVIDER_TOKEN)
    private readonly provider: DestinationProvider,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
  ) {}

  @Get('payout-banks')
  @RateLimit('bank_read')
  async banks(): Promise<ApiDataResponse<PayoutBank[]>> {
    return { data: await this.listBanks() };
  }

  @Post('me/payout-destination/resolve')
  @HttpCode(200)
  // Each lookup costs a provider call, and repeated ones could map strangers' accounts to names.
  @RateLimit('bank_resolve')
  async resolve(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(payoutBankResolveSchema))
    body: PayoutBankResolveRequest,
  ): Promise<ApiDataResponse<PayoutBankResolveResponse>> {
    const { profileId, verifiedEmail } = await this.recipient(auth.userId);
    if (!verifiedEmail)
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    const { reference } = await this.accountRoute(profileId);
    if (!reference) throw new CodedHttpException(409, 'PAYOUT_SETUP_NEEDED');
    const resolved = await this.calling('resolve', () =>
      this.provider.resolveBankAccount(body),
    );
    return {
      data: resolved
        ? { resolved: true, accountName: resolved.accountName }
        : { resolved: false },
    };
  }

  @Post('me/payout-destination/code')
  @HttpCode(202)
  @RateLimit('auth_code')
  async requestCode(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<{ sent: true }>> {
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

  @Get('me/payout-destination')
  @Header('Cache-Control', 'no-store')
  @RateLimit('bank_read')
  async current(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<PayoutDestinationState>> {
    const { profileId } = await this.recipient(auth.userId);
    const { reference } = await this.accountRoute(profileId);
    await refreshPendingDestination(this.database.db, this.provider, {
      profileId,
      accountReference: reference,
      log: (entry) => this.logger.warn(entry),
    });
    const changesFrom = await payoutBankChangesFrom(this.database.db, {
      userId: auth.userId,
    });
    return {
      data: {
        destination: await this.view(profileId),
        bankChangesFrom: changesFrom?.toISOString() ?? null,
      },
    };
  }

  @Put('me/payout-destination')
  @RateLimit('auth_verify')
  async update(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(payoutDestinationUpdateSchema))
    body: PayoutDestinationUpdateRequest,
  ): Promise<ApiDataResponse<PayoutDestinationView | null>> {
    const recipient = await this.recipient(auth.userId);
    if (!recipient.verifiedEmail)
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    const { profileId } = recipient;
    // Everything that can be refused without spending the code is refused first.
    if (await withdrawalsFrozen(this.database.db, { profileId }))
      throw new CodedHttpException(409, 'WITHDRAWALS_PAUSED');
    const { reference } = await this.accountRoute(profileId);
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
    // The add's key is fixed per account number, so its answer can be an old one replayed: it
    // never decides. Unread means under review, and the sweep or the next visit reads it again.
    let status: PayoutDestinationView['status'] = 'pending_review';
    try {
      status = await this.provider.payoutDestinationStatus(
        reference,
        added.destinationRef,
      );
    } catch (error) {
      this.logFailure('read', error);
    }
    await setPayoutDestination(this.database.db, {
      sealing: this.sealing,
      profileId,
      provider: recordedProviderName(this.provider.name),
      destinationRef: added.destinationRef,
      bankCode: bank.code,
      bankName: bank.name,
      last4: body.accountNumber.slice(-4),
      status,
    });
    return { data: await this.view(profileId) };
  }

  private async view(profileId: string): Promise<PayoutDestinationView | null> {
    const current = await getPayoutDestination(this.database.db, {
      profileId,
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

  /** The account destinations hang from; the pretend provider has none, so the profile stands in. */
  private async accountRoute(
    profileId: string,
  ): Promise<{ reference: string | null }> {
    if (this.provider.capabilities?.connectedAccounts === false)
      return { reference: profileId };
    const environment = bachsEnvironment(this.provider.name);
    if (!environment) return { reference: null };
    const account = await getBachsAccountRecoveryTarget(
      this.database.db,
      profileId,
      environment,
    );
    return { reference: account?.providerAccountReference ?? null };
  }

  private async recipient(userId: string) {
    const recipient = await getPaymentAccountRecipient(
      this.database.db,
      userId,
    );
    if (!recipient) throw new CodedHttpException(404, 'NOT_FOUND');
    return recipient;
  }

  /** A provider's own refusal is a 400-level answer; anything else is it being unreachable. */
  private async calling<T>(step: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.logFailure(step, error);
      if (
        error instanceof BachsApiError &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        error.statusCode !== 429
      )
        throw new CodedHttpException(422, 'PAYOUT_DESTINATION_REFUSED');
      throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
    }
  }

  // The error's type only: a provider message could repeat what it was sent.
  private logFailure(step: string, error: unknown): void {
    this.logger.warn({
      event: 'payout_destination.provider_failed',
      step,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
