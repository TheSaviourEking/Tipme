import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Res,
  SetMetadata,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsNoteSchema,
  opsBachsAccountRecoverySchema,
  opsBachsCheckoutRecoverySchema,
  opsBachsFeeBearerSchema,
  opsReasonSchema,
  opsRecheckSchema,
  opsResolveIssueSchema,
  type ApiDataResponse,
  type OpsNoteRequest,
  type OpsBachsAccountRecoveryRequest,
  type OpsBachsCheckoutRecoveryRequest,
  type OpsBachsFeeBearerRequest,
  type OpsReasonRequest,
  type OpsRecheckOutcome,
  type OpsRecheckRequest,
  type OpsResolveIssueRequest,
  type OpsFreezeReleased,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  addIssueNote,
  attachUnknownBachsCheckoutForOperations,
  cancelRecoveries,
  getBachsAccountRecoveryTarget,
  getBachsAttemptForFeeConfirmation,
  getUnknownBachsAttemptForOperations,
  issueById,
  recheckSubject,
  recordProviderEvent,
  recordAudit,
  recoverUnknownPaymentAccount,
  resolveIssue,
  setPageSuspension,
  freezeReleaseBySubject,
  requestSeriousAction,
  type SeriousActionServices,
} from '@tipme/database';
import {
  BachsApiError,
  bachsAccountReadiness,
  type BachsProvider,
  type MockProvider,
} from '@tipme/payments';
import type { Logger } from '@tipme/observability';
import {
  RATE_LIMIT_ROUTE,
  RateLimitGuard,
} from '../checkout/rate-limit.guard.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import {
  BACHS_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { LOGGER } from '../tokens.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import type { MailSealing } from '@tipme/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const uuidParam = (value: string) => {
  if (!UUID.test(value)) throw new CodedHttpException(404, 'NOT_FOUND');
  return value;
};

/**
 * Decisions staff can take (PR-009). None moves money: no refunds, adjustments or payout holds.
 * Every action needs a written reason and is audited in the same transaction.
 */
@Controller('v1/ops')
export class OpsActionsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly provider: MockProvider,
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly bachsProvider: BachsProvider | null,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(RateLimitGuard) private readonly rateLimit: RateLimitGuard,
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  @Post('issues/:id/resolve')
  @HttpCode(200)
  // For the document: the handler counts money closes only, so the guard isn't on this route.
  @SetMetadata(RATE_LIMIT_ROUTE, 'ops_request (money closes only)')
  @FreshCode()
  @OpsPermission('issues.resolve')
  async resolve(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsResolveIssueSchema))
    body: OpsResolveIssueRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<
      ({ resolved: true } & Partial<OpsFreezeReleased>) | OpsSeriousPending
    >
  > {
    // Closing a money issue can lift a hold, so it takes what acting on money takes.
    const issue = await issueById(this.database.db, uuidParam(id));
    if (issue?.severity === 'money' && !ops.permissions.has('payouts.resolve'))
      throw new CodedHttpException(403, 'FORBIDDEN');
    // Releasing a freeze is one person with the route's fresh code (spec 6.5); the operation demands
    // the written check, and it is audited and alerted. Nothing else about a takeover closes it.
    const releasesFreeze =
      issue?.kind === 'account_takeover_reported' &&
      issue.status === 'open' &&
      body.outcome === 'account_secured';
    // Not on your own page while someone else could; alone, it goes the alone way below and says so.
    const bySubject = releasesFreeze
      ? await freezeReleaseBySubject(this.database.db, {
          issueId: uuidParam(id),
          actorId: ops.userId,
        })
      : 'not_subject';
    if (bySubject === 'refused')
      throw new CodedHttpException(403, 'APPROVAL_SUBJECT');
    // Closing money by hand takes a second person, when there is one. Only this counts as asking.
    if (
      issue?.severity === 'money' &&
      issue.status === 'open' &&
      (!releasesFreeze || bySubject === 'alone')
    ) {
      await this.rateLimit.consumeForPerson('ops_request', ops.userId);
      const outcome = await requestSeriousAction(this.database.db, {
        name: 'money_issue.close',
        payload: {
          issueId: uuidParam(id),
          outcome: body.outcome ?? null,
          ...(body.bankAndSignInChecked !== undefined
            ? { bankAndSignInChecked: body.bankAndSignInChecked }
            : {}),
        },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      });
      const answer = pendingOr<{ resolved: true } & Partial<OpsFreezeReleased>>(
        outcome,
        response,
      );
      return { data: 'pending' in answer ? answer.pending : answer.result };
    }
    const closed = await resolveIssue(this.database.db, {
      issueId: uuidParam(id),
      staffUserId: ops.userId,
      reason: body.reason,
      ...(body.outcome ? { outcome: body.outcome } : {}),
      ...(body.bankAndSignInChecked !== undefined
        ? { bankAndSignInChecked: body.bankAndSignInChecked }
        : {}),
    });
    return { data: { resolved: true, ...closed } };
  }

  @Post('issues/:id/notes')
  @HttpCode(201)
  @OpsPermission('issues.view')
  async note(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsNoteSchema)) body: OpsNoteRequest,
  ): Promise<ApiDataResponse<{ id: string }>> {
    return {
      data: await addIssueNote(this.database.db, {
        issueId: uuidParam(id),
        staffUserId: ops.userId,
        text: body.text,
      }),
    };
  }

  @Post('pages/:profileId/suspend')
  @HttpCode(200)
  @OpsPermission('pages.suspend')
  suspend(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ handle: string }>> {
    return this.suspension(ops, profileId, body.reason, true);
  }

  @Post('pages/:profileId/unsuspend')
  @HttpCode(200)
  @OpsPermission('pages.suspend')
  unsuspend(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ handle: string }>> {
    return this.suspension(ops, profileId, body.reason, false);
  }

  /** Asks the provider about one attempt or payout; it never charges, pays or refunds. */
  @Post('recheck')
  @HttpCode(200)
  @OpsPermission('payments.recheck')
  async recheck(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsRecheckSchema)) body: OpsRecheckRequest,
  ): Promise<ApiDataResponse<{ outcome: OpsRecheckOutcome }>> {
    return {
      data: await recheckSubject({
        db: this.database.db,
        provider: (name) => {
          if (name === 'mock') return this.provider;
          if (name === 'bachs' && this.bachsProvider) return this.bachsProvider;
          throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
        },
        attemptId: body.attemptId,
        payoutId: body.payoutId,
        staffUserId: ops.userId,
        reason: body.reason,
      }),
    };
  }

  /** Verifies a dashboard-found checkout before linking it; unknown/mismatched IDs stay unlinked. */
  @Post('bachs/checkout-recovery')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('payments.repair')
  async recoverBachsCheckout(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsBachsCheckoutRecoverySchema))
    body: OpsBachsCheckoutRecoveryRequest,
  ): Promise<
    ApiDataResponse<{
      outcome:
        'attached' | 'pending' | 'not_found' | 'mismatch' | 'not_pending';
    }>
  > {
    const issue = await issueById(this.database.db, body.issueId);
    if (
      !issue ||
      issue.kind !== 'payment_attempt_unresolved' ||
      issue.status !== 'open' ||
      issue.subject.attemptId !== body.attemptId
    ) {
      throw new CodedHttpException(404, 'NOT_FOUND');
    }

    // The lookup is scoped to this copy's Bachs environment, so it needs the adapter first.
    if (!this.bachsProvider)
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    const { environment } = this.bachsProvider;
    const target = await getUnknownBachsAttemptForOperations(
      this.database.db,
      body.attemptId,
      environment,
    );
    if (!target) {
      await this.auditBachsRecovery(
        ops,
        'payment_attempt.checkout_recovery_not_pending',
        body.attemptId,
        body.reason,
      );
      return { data: { outcome: 'not_pending' } };
    }

    let answer: Awaited<ReturnType<BachsProvider['verifyTransaction']>>;
    try {
      answer = await this.bachsProvider.verifyTransaction(
        `${target.accountReference}:${body.checkoutId}`,
        target.expectation,
      );
    } catch (error) {
      if (error instanceof BachsApiError && error.statusCode === 404) {
        await this.auditBachsRecovery(
          ops,
          'payment_attempt.checkout_recovery_not_found',
          body.attemptId,
          body.reason,
        );
        return { data: { outcome: 'not_found' } };
      }
      this.logger.warn({
        event: 'ops.bachs_checkout_recovery_failed',
        error: error instanceof Error ? error.name : typeof error,
      });
      await this.auditBachsRecovery(
        ops,
        'payment_attempt.checkout_recovery_error',
        body.attemptId,
        body.reason,
      );
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    }

    if (answer.status === 'not_found') {
      await this.auditBachsRecovery(
        ops,
        'payment_attempt.checkout_recovery_not_found',
        body.attemptId,
        body.reason,
      );
      return { data: { outcome: 'not_found' } };
    }
    if (
      answer.amountMinor !== target.amountMinor ||
      answer.currency !== target.currency
    ) {
      await this.auditBachsRecovery(
        ops,
        'payment_attempt.checkout_recovery_mismatch',
        body.attemptId,
        body.reason,
      );
      return { data: { outcome: 'mismatch' } };
    }

    const providerReference = `${target.accountReference}:${body.checkoutId}`;
    const attached = await attachUnknownBachsCheckoutForOperations(
      this.database.db,
      {
        issueId: body.issueId,
        attemptId: body.attemptId,
        environment,
        providerReference,
        accountReference: target.accountReference,
        amountMinor: target.amountMinor,
        currency: target.currency,
        staffUserId: ops.userId,
        reason: body.reason,
      },
    );
    if (!attached) {
      await this.auditBachsRecovery(
        ops,
        'payment_attempt.checkout_recovery_not_pending',
        body.attemptId,
        body.reason,
      );
      return { data: { outcome: 'not_pending' } };
    }

    if (answer.status === 'succeeded' && answer.feePaidBy !== 'platform') {
      return { data: { outcome: 'pending' } };
    }
    if (answer.status === 'succeeded' || answer.status === 'failed') {
      const event = await recordProviderEvent(this.database.db, {
        provider: 'bachs',
        providerEventId: `ops.recovery.${body.attemptId}.${body.checkoutId}`,
        eventType:
          answer.status === 'succeeded'
            ? 'payment.succeeded'
            : 'payment.failed',
        attemptId: body.attemptId,
        providerReference,
        amountMinor: answer.amountMinor,
        currency: answer.currency,
        providerFeeMinor: answer.feeMinor,
        signatureVerified: true,
        payload: { source: 'staff_checkout_recovery' },
      });
      return {
        data: {
          outcome:
            event.outcome === 'applied' || event.outcome === 'duplicate'
              ? 'attached'
              : 'pending',
        },
      };
    }
    return { data: { outcome: 'pending' } };
  }

  /** Fetches Bachs state before linking a dashboard-matched account to a verified recipient. */
  /**
   * Bachs took the money but never reported who paid its processing fee (`fee_paid_by` empty), so
   * the tip stays confirming. Staff who see in the Bachs dashboard that the platform paid it
   * confirm that one fact. The payment is read back from Bachs and booked only when it is still
   * collected-but-unfinished and its amount, currency and TipMe fee match the quote; Bachs saying
   * the recipient paid the fee always wins. Every outcome is audited.
   */
  @Post('bachs/fee-bearer-confirmation')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('payments.repair')
  async confirmBachsFeeBearer(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsBachsFeeBearerSchema))
    body: OpsBachsFeeBearerRequest,
  ): Promise<
    ApiDataResponse<{
      outcome:
        | 'confirmed'
        | 'not_pending'
        | 'not_collected'
        | 'mismatch'
        | 'recipient_bore_fee';
    }>
  > {
    const issue = await issueById(this.database.db, body.issueId);
    const subject = issue?.subject ?? {};
    if (
      !issue ||
      issue.status !== 'open' ||
      (!subject.attemptId && !subject.tipId)
    )
      throw new CodedHttpException(404, 'NOT_FOUND');
    const target = await getBachsAttemptForFeeConfirmation(this.database.db, {
      ...(subject.attemptId ? { attemptId: subject.attemptId } : {}),
      ...(subject.tipId ? { tipId: subject.tipId } : {}),
    });
    if (!target) throw new CodedHttpException(404, 'NOT_FOUND');
    const audit = (action: string) =>
      this.auditBachsRecovery(
        ops,
        `payment_attempt.${action}`,
        target.attemptId,
        body.reason,
      );
    if (!target.unfinished) {
      await audit('fee_bearer_not_pending');
      return { data: { outcome: 'not_pending' } };
    }
    if (!target.collected) {
      await audit('fee_bearer_not_collected');
      return { data: { outcome: 'not_collected' } };
    }
    if (!this.bachsProvider)
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');

    let answer: Awaited<ReturnType<BachsProvider['verifyTransaction']>>;
    try {
      answer = await this.bachsProvider.verifyTransaction(
        target.providerReference,
        target.expectation,
      );
    } catch (error) {
      this.logger.warn({
        event: 'ops.bachs_fee_bearer_failed',
        error: error instanceof Error ? error.name : typeof error,
      });
      await audit('fee_bearer_error');
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    }
    if (answer.feePaidBy === 'connected_account') {
      await audit('fee_bearer_recipient');
      return { data: { outcome: 'recipient_bore_fee' } };
    }
    if (
      answer.amountMinor !== target.amountMinor ||
      answer.currency !== target.currency ||
      answer.platformFeeMinor !== target.expectation.platformFeeMinor
    ) {
      await audit('fee_bearer_mismatch');
      return { data: { outcome: 'mismatch' } };
    }
    if (
      answer.status !== 'succeeded' &&
      !(answer.status === 'pending' && answer.collected)
    ) {
      await audit('fee_bearer_not_collected');
      return { data: { outcome: 'not_collected' } };
    }
    const event = await recordProviderEvent(this.database.db, {
      provider: 'bachs',
      providerEventId: `ops.fee-bearer.${target.attemptId}`,
      eventType: 'payment.succeeded',
      attemptId: target.attemptId,
      providerReference: target.providerReference,
      amountMinor: answer.amountMinor,
      currency: answer.currency,
      providerFeeMinor: answer.feeMinor,
      signatureVerified: true,
      payload: { source: 'staff_fee_bearer_confirmation' },
    });
    if (event.outcome !== 'applied') {
      await audit('fee_bearer_not_pending');
      return { data: { outcome: 'not_pending' } };
    }
    await audit('fee_bearer_confirmed');
    return { data: { outcome: 'confirmed' } };
  }

  @Post('bachs/account-recovery')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('payments.repair')
  async recoverBachsAccount(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsBachsAccountRecoverySchema))
    body: OpsBachsAccountRecoveryRequest,
  ): Promise<
    ApiDataResponse<{
      outcome: 'recovered' | 'not_found' | 'mismatch' | 'not_pending';
      status?: 'ACTIVE' | 'ONBOARDING' | 'RESTRICTED';
    }>
  > {
    const issue = await issueById(this.database.db, body.issueId);
    if (
      !issue ||
      issue.kind !== 'payment_account_unresolved' ||
      issue.status !== 'open' ||
      !issue.subject.profileId
    ) {
      throw new CodedHttpException(404, 'NOT_FOUND');
    }
    const profileId = issue.subject.profileId;
    // The lookup is scoped to this copy's Bachs environment, so it needs the adapter first.
    if (!this.bachsProvider)
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    const { environment } = this.bachsProvider;
    const target = await getBachsAccountRecoveryTarget(
      this.database.db,
      profileId,
      environment,
    );
    if (
      !target ||
      target.status !== 'UNKNOWN' ||
      target.providerAccountReference !== null
    ) {
      await this.auditBachsRecovery(
        ops,
        'payment_account.recovery_not_pending',
        body.issueId,
        body.reason,
      );
      return { data: { outcome: 'not_pending' } };
    }
    if (!target.emailVerified)
      throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');

    let remoteAccount: Awaited<
      ReturnType<BachsProvider['getRecipientAccount']>
    >;
    try {
      remoteAccount = await this.bachsProvider.getRecipientAccount(
        body.accountReference,
      );
    } catch (error) {
      if (error instanceof BachsApiError && error.statusCode === 404) {
        await this.auditBachsRecovery(
          ops,
          'payment_account.recovery_not_found',
          body.issueId,
          body.reason,
        );
        return { data: { outcome: 'not_found' } };
      }
      this.logger.warn({
        event: 'ops.bachs_account_recovery_failed',
        error: error instanceof Error ? error.name : typeof error,
      });
      await this.auditBachsRecovery(
        ops,
        'payment_account.recovery_error',
        body.issueId,
        body.reason,
      );
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    }

    if (remoteAccount.accountReference !== body.accountReference) {
      await this.auditBachsRecovery(
        ops,
        'payment_account.recovery_mismatch',
        body.issueId,
        body.reason,
      );
      return { data: { outcome: 'mismatch' } };
    }
    const { status, chargesEnabled } = bachsAccountReadiness(remoteAccount);
    await recoverUnknownPaymentAccount(this.database.db, {
      issueId: body.issueId,
      profileId,
      environment,
      providerAccountReference: body.accountReference,
      status,
      chargesEnabled,
      feeCollector: remoteAccount.feeCollector,
      requirementsDue: remoteAccount.requirementsDue,
      dashboardVerified: true,
      staffUserId: ops.userId,
      reason: body.reason,
    });
    return { data: { outcome: 'recovered', status } };
  }

  @Post('users/:userId/cancel-recovery')
  @HttpCode(200)
  @OpsPermission('recoveries.cancel')
  async cancelRecovery(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ cancelled: number }>> {
    const cancelled = await cancelRecoveries(
      this.database.db,
      uuidParam(userId),
    );
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'recovery.cancelled',
      permission: 'recoveries.cancel',
      subjectType: 'user',
      subjectId: userId,
      reason: `${body.reason} [cancelled: ${cancelled}]`,
    });
    return { data: { cancelled } };
  }

  private async suspension(
    ops: OpsContext,
    profileId: string,
    reason: string,
    suspend: boolean,
  ): Promise<ApiDataResponse<{ handle: string }>> {
    const { handle } = await setPageSuspension(this.database.db, {
      sealing: this.sealing,
      profileId: uuidParam(profileId),
      staffUserId: ops.userId,
      suspend,
      reason,
    });
    this.revalidator.revalidate(handle);
    // The owner's open dashboard shows (or drops) the paused-page notice.
    void this.publishLive({
      to: { profile: profileId },
      type: 'profile.changed',
    });
    return { data: { handle } };
  }

  private auditBachsRecovery(
    ops: OpsContext,
    action: string,
    subjectId: string,
    reason: string,
  ): Promise<void> {
    return recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action,
      permission: 'payments.repair',
      subjectType: 'provider_recovery',
      subjectId,
      reason,
    });
  }
}
