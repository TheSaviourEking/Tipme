import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiDataResponse,
  CollectBankAddRequest,
  CollectBankAddResponse,
  CollectBankLookupRequest,
  CollectBankLookupResponse,
  CollectBankState,
  CollectLegalName,
  CollectStatusView,
  PayoutBank,
} from '@tipme/contracts';
import {
  collectBankAddSchema,
  collectBankLookupSchema,
  recordedProviderName,
} from '@tipme/contracts';
import {
  bankAccountHash,
  bankCheckedForAnotherName,
  beginPaymentAccountCreation,
  collectAccountReference,
  collectBankFacts,
  collectBankView,
  collectDisputeHeldMinor,
  collectStatus,
  ensurePayoutSetup,
  flagSharedBank,
  getPaymentAccountRecipient,
  legalNameDigest,
  markPaymentAccountCreationFailed,
  markPaymentAccountCreationUnknown,
  payoutBankChangesFrom,
  recordCollectLegalName,
  recordPartnerName,
  reportProviderKeyRefused,
  sameLegalName,
  setPayoutDestination,
  settleCollectVerification,
  spendPayoutDestinationCode,
  updatePaymentAccountStatus,
  withdrawalsFrozen,
  type CollectBankFacts,
  type MailSealing,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import {
  BachsApiError,
  bachsEnvironment,
  type BachsRecipientAccount,
  type PayoutPort,
} from '@tipme/payments';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  effectiveCollectionMode,
  fixCollectionMode,
} from '../checkout/collection-mode.js';
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
import {
  PARTNER_QUOTE_CACHE,
  type RedisPartnerQuoteCache,
} from '../infra/partner-quote-cache.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { LOGGER } from '../tokens.js';

// As the payout-destination routes: banks rarely change, and each read is a partner call.
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;

/** What adding bank details asks of our payment partner (the Bachs adapter, or the mock). */
type CollectBankProvider = Pick<
  PayoutPort,
  | 'listBanks'
  | 'resolveBankAccount'
  | 'addPayoutDestination'
  | 'payoutDestinationStatus'
  | 'payoutCapability'
  | 'requestPayoutCapabilities'
  | 'setManualPayouts'
  | 'createReceiveOnlyPersonAccount'
  | 'nameReceiveOnlyPerson'
> & {
  name: string;
  capabilities?: { connectedAccounts: boolean };
  holdLocalCurrency?: (reference: string) => Promise<BachsRecipientAccount>;
};

type Collector = { profileId: string; verifiedEmail: string | null };

/**
 * You collect (plan Task 13; spec §2.1 steps 4–5, §8, §10): a recipient's legal name and a bank
 * account in that name, checked by our payment partner. Own page only, and only for a recipient on
 * You collect: anyone else is told there is nothing here (404). The full account number passes
 * through to the partner and is never stored, logged or returned: TipMe keeps the last four digits
 * and a keyed hash. The legal name is kept for the partner's check and never returned or logged.
 */
@Controller('v1/me/collect')
@UseGuards(SessionGuard, CsrfGuard)
export class CollectBankController {
  private banksCache: { banks: PayoutBank[]; at: number } | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(WITHDRAWAL_PROVIDER_TOKEN)
    private readonly provider: CollectBankProvider,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(PARTNER_QUOTE_CACHE)
    private readonly partnerCache: Pick<RedisPartnerQuoteCache, 'invalidate'>,
  ) {}

  /** Their You collect state (Task 12) and their bank; a check that has ended is finished here. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit('bank_read')
  async status(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<CollectStatusView>> {
    const { profileId } = await this.collector(auth.userId);
    const now = new Date();
    await settleCollectVerification(this.database.db, {
      profileId,
      provider: this.provider,
      accountReference: await this.accountReference(profileId),
      sealing: this.sealing,
      now,
      log: (entry) => this.logger.warn(entry),
    });
    const status = await collectStatus(this.database.db, profileId, now);
    return {
      data: {
        // On You collect, or undecided and previewed onto it (collector): never direct here.
        mode: 'collect',
        verified: status.verified,
        heldMinor: status.heldMinor.toString(),
        keptMinor: status.keptMinor.toString(),
        onItsWayMinor: status.onItsWayMinor.toString(),
        refundHeldMinor: status.refundHeldMinor.toString(),
        firstWaitingAt: status.firstWaitingAt?.toISOString() ?? null,
        paused: status.paused,
        pausedReason: status.pausedReason,
        pauseOn: status.pauseOn?.toISOString() ?? null,
        firstWithdrawalCapMinor:
          status.firstWithdrawalCapMinor?.toString() ?? null,
        dailyLimitMinor: status.dailyLimitMinor?.toString() ?? null,
        bank: await collectBankView(this.database.db, {
          profileId,
          provider: this.provider.name,
        }),
        disputeHeldMinor: (
          await collectDisputeHeldMinor(this.database.db, profileId)
        ).toString(),
      },
    };
  }

  /** "Is this you? {BANK NAME}": the bank's name for the account. Nothing is stored. */
  @Post('bank/lookup')
  @HttpCode(200)
  // Each lookup costs a partner call, and repeated ones could map strangers' accounts to names.
  @RateLimit('bank_resolve')
  async lookup(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(collectBankLookupSchema))
    body: CollectBankLookupRequest,
  ): Promise<ApiDataResponse<CollectBankLookupResponse>> {
    const collector = await this.collector(auth.userId);
    if (!collector.verifiedEmail)
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    const resolved = await this.calling('resolve', () =>
      this.provider.resolveBankAccount({
        accountNumber: body.accountNumber,
        bankCode: body.bankCode,
      }),
    );
    if (!resolved) throw new CodedHttpException(422, 'BANK_NAME_UNKNOWN');
    return { data: { bankName: resolved.accountName } };
  }

  /**
   * The confirmed name and bank: the partner account is created (or reused, R7), named, made to hold
   * naira (P12) and set to pay out by hand, then the bank is added and the partner compares names.
   * Usable is `verified` once the account can receive (else `checking`), pending review is
   * `manual_review`, and rejected is `422 NAME_MISMATCH` with nothing saved.
   */
  @Post('bank')
  @HttpCode(200)
  // Spends an email code, as the payout-destination change does.
  @RateLimit('auth_verify')
  async add(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(collectBankAddSchema))
    body: CollectBankAddRequest,
  ): Promise<ApiDataResponse<CollectBankAddResponse>> {
    const { db } = this.database;
    const collector = await this.collector(auth.userId, { fix: true });
    const { profileId } = collector;
    if (!collector.verifiedEmail)
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    const facts = await collectBankFacts(db, profileId);
    // The name lock (spec §2.1): once verified, only support changes it.
    if (facts.verifiedAt && !sameLegalName(facts.legalName, body.legalName))
      throw new CodedHttpException(409, 'NAME_LOCKED');
    // Everything that can be refused without spending the code is refused first.
    if (await withdrawalsFrozen(db, { profileId }))
      throw new CodedHttpException(409, 'WITHDRAWALS_PAUSED');
    if (await payoutBankChangesFrom(db, { userId: auth.userId }))
      throw new CodedHttpException(409, 'BANK_CHANGE_HELD');
    const bank = (await this.listBanks()).find(
      ({ code }) => code === body.bankCode,
    );
    if (!bank) throw new CodedHttpException(400, 'PAYOUT_DESTINATION_REFUSED');
    await this.spendCode(auth.userId, body.emailCode);

    const digest = legalNameDigest(body.legalName);
    let reference: string | null = null;
    let accountHash: string;
    const now = new Date();
    try {
      reference = await this.personAccount(collector, body.legalName, facts);
      const account = reference;
      const added = await this.calling('add', () =>
        this.provider.addPayoutDestination(account, {
          accountNumber: body.accountNumber,
          accountName: `${body.legalName.first} ${body.legalName.last}`,
          bankCode: body.bankCode,
          nameDigest: digest,
        }),
      );
      // The add's key is fixed per account number, so its answer can be an old one replayed: the
      // read decides. Unread means under review, and the next read finishes it.
      let status = added.status;
      try {
        status = await this.provider.payoutDestinationStatus(
          account,
          added.destinationRef,
        );
      } catch (error) {
        this.logFailure('read', error);
        if (status !== 'rejected') status = 'pending_review';
      }
      if (status === 'rejected') {
        // Nothing is saved: not the bank, and not the refused name.
        this.logger.warn({ event: 'collect_bank.name_mismatch' });
        throw new CodedHttpException(422, 'NAME_MISMATCH');
      }
      // C1b: an answer for a destination already checked under another name (current or replaced)
      // may be a replay decided against that name, and proves nothing about this one.
      if (
        await bankCheckedForAnotherName(db, {
          profileId,
          provider: this.provider.name,
          destinationRef: added.destinationRef,
          nameDigest: digest,
        })
      ) {
        this.logger.warn({ event: 'collect_bank.replayed_for_another_name' });
        throw new CodedHttpException(409, 'BANK_RECHECK_LATER');
      }
      accountHash = bankAccountHash(
        this.sealing,
        body.bankCode,
        body.accountNumber,
      );
      await setPayoutDestination(db, {
        sealing: this.sealing,
        profileId,
        provider: recordedProviderName(this.provider.name),
        destinationRef: added.destinationRef,
        bankCode: bank.code,
        bankName: bank.name,
        last4: body.accountNumber.slice(-4),
        status,
        accountHash,
        nameDigest: digest,
        now,
      });
      // The name TipMe holds is the one its current bank was checked against: only now (C1).
      await recordCollectLegalName(db, {
        profileId,
        legalName: body.legalName,
      });
    } catch (error) {
      // I2: whatever failed after the partner was given this name, it goes back to the one TipMe
      // holds, so their record never keeps a refused or unfinished name.
      await this.restorePartnerName(profileId, facts);
      throw error;
    }
    // Before verification can release anything: a shared account holds the second recipient.
    if (await flagSharedBank(db, { profileId, accountHash, now }))
      this.logger.warn({ event: 'collect_bank.same_bank' });
    await this.partnerCache.invalidate({
      provider: this.provider.name,
      profileId,
    });
    const state: CollectBankState =
      (await settleCollectVerification(db, {
        profileId,
        provider: this.provider,
        accountReference: reference,
        sealing: this.sealing,
        now,
        log: (entry) => this.logger.warn(entry),
      })) ?? 'checking';
    return { data: { state } };
  }

  /**
   * The partner account the bank hangs from, holding the legal name (sent only if it changed). The
   * pretend provider has no accounts, so the profile stands in. A new account's reference is kept the moment create answers
   * (Task 4 note), so a retry names that account and never creates a second; an existing one, such
   * as a never-verified recipient's from before You collect (R7, P22), is reused, never duplicated.
   */
  private async personAccount(
    collector: Collector,
    legalName: CollectLegalName,
    facts: CollectBankFacts,
  ): Promise<string> {
    const { db } = this.database;
    const { profileId } = collector;
    if (this.provider.capabilities?.connectedAccounts === false)
      return profileId;
    const environment = bachsEnvironment(this.provider.name);
    const create = this.provider.createReceiveOnlyPersonAccount;
    const hold = this.provider.holdLocalCurrency;
    if (!environment || !create || !hold || !collector.verifiedEmail)
      throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
    const claim = await beginPaymentAccountCreation(db, {
      profileId,
      provider: 'bachs',
      environment,
    });
    const where = { profileId, provider: 'bachs', environment } as const;
    let reference = claim.account.providerAccountReference;
    if (claim.created) {
      let kept = false;
      try {
        await create.call(this.provider, {
          contactEmail: collector.verifiedEmail,
          country: 'NG',
          legalName,
          idempotencyKey: `tipme-collect-acct-${claim.account.id}`,
          onCreated: async (created) => {
            await updatePaymentAccountStatus(db, {
              ...where,
              sealing: this.sealing,
              providerAccountReference: created,
              status: 'ONBOARDING',
              chargesEnabled: false,
              payoutsEnabled: false,
              feeCollector: 'unknown',
              requirementsDue: [],
            });
            reference = created;
            kept = true;
          },
        });
      } catch (error) {
        this.logFailure('create', error);
        // Named or not, the account exists and is kept: the next try names it.
        if (kept)
          throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
        if (
          error instanceof BachsApiError &&
          error.statusCode >= 400 &&
          error.statusCode < 500 &&
          error.statusCode !== 429
        ) {
          await markPaymentAccountCreationFailed(db, where);
          throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
        }
        // It may exist at the partner: never created again; staff recover it.
        await markPaymentAccountCreationUnknown(db, where);
        throw new CodedHttpException(503, 'PROVIDER_OUTCOME_UNKNOWN');
      }
      await recordPartnerName(db, { profileId, legalName });
    } else {
      if (!reference)
        throw new CodedHttpException(
          503,
          claim.account.status === 'UNKNOWN'
            ? 'PROVIDER_OUTCOME_UNKNOWN'
            : 'DEPENDENCY_UNAVAILABLE',
        );
      // I1: only a changed name is sent (a support change, a new spelling before verification).
      if (facts.partnerNameDigest !== legalNameDigest(legalName))
        await this.namePartner(profileId, reference, legalName);
    }
    if (!reference)
      throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
    const account = reference;
    // P12: a new account holds only USD, and a naira transfer to it would be converted.
    await this.calling('hold', () => hold.call(this.provider, account));
    // A bank on an account with automatic payouts could be paid out with no record here: manual
    // payouts are set before any bank goes on.
    const setup = await ensurePayoutSetup(db, {
      profileId,
      provider: {
        name: this.provider.name,
        environment,
        setManualPayouts: (ref) => this.provider.setManualPayouts(ref),
        payoutCapability: (ref) => this.provider.payoutCapability(ref),
        requestPayoutCapabilities: (ref) =>
          this.provider.requestPayoutCapabilities(ref),
        payoutDestinationStatus: (ref, dest) =>
          this.provider.payoutDestinationStatus(ref, dest),
      },
      log: (entry) => this.logger.warn(entry),
    });
    if (!setup.manualPayouts)
      throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
    return account;
  }

  /**
   * Gives the partner this legal name. Each write has its own key (I1): a name sent before, then
   * changed, then sent again is really written again, never replayed. Recorded once answered; an
   * unknown answer leaves the record unknown, so the next add sends it again.
   */
  private async namePartner(
    profileId: string,
    reference: string,
    legalName: CollectLegalName,
  ): Promise<void> {
    const rename = this.provider.nameReceiveOnlyPerson;
    if (!rename)
      throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
    await recordPartnerName(this.database.db, { profileId, legalName: null });
    await this.calling('name', () =>
      rename.call(this.provider, {
        accountReference: reference,
        legalName,
        idempotencyKey: `tipme-collect-name-${randomUUID()}`,
      }),
    );
    await recordPartnerName(this.database.db, { profileId, legalName });
  }

  /** After a failed or refused add: the partner gets back the name TipMe holds (I2). */
  private async restorePartnerName(
    profileId: string,
    before: CollectBankFacts,
  ): Promise<void> {
    if (this.provider.capabilities?.connectedAccounts === false) return;
    const held = before.legalName;
    if (!held) return;
    try {
      const now = await collectBankFacts(this.database.db, profileId);
      if (now.partnerNameDigest === legalNameDigest(held)) return;
      const reference = await this.accountReference(profileId);
      if (!reference) return;
      await this.namePartner(profileId, reference, held);
    } catch {
      // Left unknown: the next add sends the held name again, and nothing verifies meanwhile (C1).
      this.logger.warn({ event: 'collect_bank.name_restore_failed' });
    }
  }

  private async spendCode(userId: string, code: string): Promise<void> {
    const checked = await spendPayoutDestinationCode(this.database.db, {
      userId,
      code,
      secret: this.config.AUTH_CODE_SECRET,
    });
    if (checked === 'locked')
      throw new CodedHttpException(429, 'SIGN_IN_LOCKED');
    if (checked === 'no_email')
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    if (checked === 'held')
      throw new CodedHttpException(409, 'BANK_CHANGE_HELD');
    if (checked !== 'ok') throw new CodedHttpException(400, 'CODE_INVALID');
  }

  private accountReference(profileId: string): Promise<string | null> {
    return collectAccountReference(this.database.db, {
      profileId,
      provider:
        this.provider.capabilities?.connectedAccounts === false
          ? 'mock'
          : recordedProviderName(this.provider.name),
      environment: bachsEnvironment(this.provider.name),
    });
  }

  /**
   * The signed-in recipient, only while they are on You collect (whatever the switch says now), or
   * undecided while their next quote would put them on it (re-review 2 R2-I1). `fix`: adding bank
   * details settles an undecided mode through the quote's own decision first, so the two can never
   * disagree later; a read only previews it and writes nothing.
   */
  private async collector(
    userId: string,
    { fix = false }: { fix?: boolean } = {},
  ): Promise<Collector> {
    const recipient = await getPaymentAccountRecipient(
      this.database.db,
      userId,
    );
    if (!recipient) throw new CodedHttpException(404, 'NOT_FOUND');
    const mode = await (fix ? fixCollectionMode : effectiveCollectionMode)(
      this.database.db,
      recipient.profileId,
      this.config.PAYMENT_PROVIDER,
    );
    if (mode !== 'collect') throw new CodedHttpException(404, 'NOT_FOUND');
    return {
      profileId: recipient.profileId,
      verifiedEmail: recipient.verifiedEmail,
    };
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

  /** A partner's refusal of the details is a 400-level answer; anything else is it being unreachable. */
  private async calling<T>(step: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.logFailure(step, error);
      if (
        error instanceof BachsApiError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        await reportProviderKeyRefused(this.database.db, {}).catch(() =>
          this.logFailure('report_key_refused', new Error('not recorded')),
        );
        throw new CodedHttpException(503, 'PAYOUT_PROVIDER_UNAVAILABLE');
      }
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

  // The error's type only: a partner message could repeat what it was sent (number, name).
  private logFailure(step: string, error: unknown): void {
    this.logger.warn({
      event: 'collect_bank.provider_failed',
      step,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
