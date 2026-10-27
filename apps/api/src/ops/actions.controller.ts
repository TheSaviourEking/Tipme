import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  opsNoteSchema,
  opsBachsAccountRecoverySchema,
  opsBachsCheckoutRecoverySchema,
  opsReasonSchema,
  opsRecheckSchema,
  type ApiDataResponse,
  type OpsNoteRequest,
  type OpsBachsAccountRecoveryRequest,
  type OpsBachsCheckoutRecoveryRequest,
  type OpsReasonRequest,
  type OpsRecheckOutcome,
  type OpsRecheckRequest,
} from '@tipme/contracts';
import {
  addIssueNote,
  attachUnknownBachsCheckoutForOperations,
  cancelRecoveries,
  getBachsAccountRecoveryTarget,
  getUnknownBachsAttemptForOperations,
  issueById,
  recheckSubject,
  recordProviderEvent,
  recordAudit,
  recoverUnknownPaymentAccount,
  resolveIssue,
  setPageSuspension,
} from '@tipme/database';
import {
  BachsApiError,
  bachsAccountReadiness,
  type BachsProvider,
  type MockProvider,
} from '@tipme/payments';
import type { Logger } from '@tipme/observability';
import {
  BACHS_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { LOGGER } from '../tokens.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidParam = (value: string) => {
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
  ) {}

  @Post('issues/:id/resolve')
  @HttpCode(200)
  @OpsPermission('issues.resolve')
  async resolve(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ resolved: true }>> {
    await resolveIssue(this.database.db, {
      issueId: uuidParam(id),
      staffUserId: ops.userId,
      reason: body.reason,
    });
    return { data: { resolved: true } };
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
  @OpsPermission('payments.recheck')
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

    const target = await getUnknownBachsAttemptForOperations(
      this.database.db,
      body.attemptId,
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
    if (!this.bachsProvider)
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');

    let answer: Awaited<ReturnType<BachsProvider['verifyTransaction']>>;
    try {
      answer = await this.bachsProvider.verifyTransaction(
        `${target.accountReference}:${body.checkoutId}`,
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
  @Post('bachs/account-recovery')
  @HttpCode(200)
  @OpsPermission('payments.recheck')
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
    const target = await getBachsAccountRecoveryTarget(
      this.database.db,
      profileId,
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
    if (!this.bachsProvider)
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');

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
      profileId: uuidParam(profileId),
      staffUserId: ops.userId,
      suspend,
      reason,
    });
    this.revalidator.revalidate(handle);
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
      permission: 'payments.recheck',
      subjectType: 'provider_recovery',
      subjectId,
      reason,
    });
  }
}
