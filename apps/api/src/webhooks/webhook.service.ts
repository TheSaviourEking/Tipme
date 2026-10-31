import { Inject, Injectable } from '@nestjs/common';
import type { MockWebhook } from '@tipme/contracts';
import {
  bachsAccountReadiness,
  type BachsProvider,
  type NormalizedProviderEvent,
} from '@tipme/payments';
import { z } from 'zod';
import {
  enqueueOutbox,
  findBachsAttemptByOperationReference,
  findPaymentAccountByReference,
  updatePaymentAccountStatus,
  findBachsAttemptByReference,
  findAttemptByReference,
  findPayoutByReference,
  OperationError,
  reconcileAttempts,
  recordPayoutOutcome,
  recordProviderEvent,
  recordUnmatchedEvent,
} from '@tipme/database';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import type { MailSealing } from '@tipme/database';

const PROVIDER = 'mock';

/**
 * Applies a verified provider message through the PR-005 operations. Matching is by the provider's
 * reference (recorded when the payment or payout started), never by an ID the message claims.
 */
@Injectable()
export class WebhookService {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
  ) {}

  async apply(event: MockWebhook): Promise<string> {
    const { db } = this.database;
    const { reference } = event.data;
    if (event.type.startsWith('payment.')) {
      const attemptId = await findAttemptByReference(db, PROVIDER, reference);
      if (!attemptId) return this.unmatched(event, 'unknown_attempt');
      const result = await recordProviderEvent(db, {
        provider: PROVIDER,
        providerEventId: event.id,
        eventType: event.type as
          'payment.pending' | 'payment.succeeded' | 'payment.failed',
        attemptId,
        providerReference: reference,
        amountMinor: BigInt(event.data.amountMinor),
        currency: event.data.currency,
        providerFeeMinor: BigInt(event.data.feeMinor),
        signatureVerified: true,
        payload: event,
      });
      return result.outcome;
    }
    const payoutId = await findPayoutByReference(db, PROVIDER, reference);
    if (!payoutId) return this.unmatched(event, 'unknown_payout');
    const result = await recordPayoutOutcome(db, {
      payoutId,
      provider: PROVIDER,
      providerEventId: event.id,
      providerReference: reference,
      outcome: event.type.slice('payout.'.length) as
        'processing' | 'paid' | 'failed',
      signatureVerified: true,
      payload: event,
    });
    return result.outcome;
  }

  async applyBachs(
    event: NormalizedProviderEvent,
    accounts?: Partial<
      Pick<BachsProvider, 'getRecipientAccount' | 'verifyTransaction'>
    >,
  ): Promise<string> {
    if (event.kind === 'ignored') return 'ignored';
    if (event.kind === 'account')
      return this.refreshBachsAccount(event, accounts);
    if (event.kind === 'reversal') return this.flagBachsReversal(event);
    const { providerReference } = event;
    const attemptId = await this.matchBachsAttempt(event);
    if (!attemptId || !providerReference) return this.unmatchedBachs(event);

    try {
      const result = await recordProviderEvent(this.database.db, {
        provider: 'bachs',
        providerEventId: event.eventId,
        eventType: 'payment.pending',
        attemptId,
        providerReference,
        ...(event.amountMinor === undefined
          ? {}
          : { amountMinor: event.amountMinor }),
        ...(event.currency === undefined ? {} : { currency: event.currency }),
        ...(event.feeMinor === undefined
          ? {}
          : { providerFeeMinor: event.feeMinor }),
        signatureVerified: true,
        payload: event,
      });
      // The webhook only proves something happened; read the payment back from Bachs now, with
      // the worker's own checks (quoted share, fee bearer), so the receipt turns paid at once.
      // A failed read changes nothing: the worker keeps checking.
      if (accounts?.verifyTransaction) {
        const { verifyTransaction } = accounts;
        const checked = await reconcileAttempts({
          db: this.database.db,
          provider: {
            verifyTransaction: (reference, expectation) =>
              verifyTransaction(reference, expectation),
          },
          now: new Date(),
          minAgeMs: 0,
          attemptId,
        });
        if (checked.applied > 0) return 'confirmed';
      }
      return result.outcome;
    } catch (error) {
      if (error instanceof OperationError && error.code === 'INVALID_INPUT') {
        return this.unmatchedBachs(event);
      }
      throw error;
    }
  }

  private async unmatched(
    event: MockWebhook,
    reason: 'unknown_attempt' | 'unknown_payout',
  ): Promise<string> {
    await recordUnmatchedEvent(this.database.db, {
      provider: PROVIDER,
      providerEventId: event.id,
      eventType: event.type,
      payload: event,
      reason,
    });
    return 'unmatched';
  }

  /** The attempt a Bachs event is about, matched only through the persisted account mapping. */
  private async matchBachsAttempt(event: {
    accountReference: string | null;
    operationReference: string | null;
    providerReference: string | null;
  }): Promise<string | null> {
    const { accountReference, operationReference, providerReference } = event;
    if (!accountReference || !providerReference) return null;
    if (operationReference) {
      if (!z.uuid().safeParse(operationReference).success) return null;
      return findBachsAttemptByOperationReference(this.database.db, {
        attemptId: operationReference,
        accountReference,
      });
    }
    return findBachsAttemptByReference(this.database.db, {
      providerReference,
      accountReference,
    });
  }

  /**
   * Refunds and disputes are not modelled yet (ADR-0004): each one raises a money issue for
   * staff, once per Bachs event, and never changes a balance or the ledger.
   */
  private async flagBachsReversal(
    event: Extract<NormalizedProviderEvent, { kind: 'reversal' }>,
  ): Promise<string> {
    const attemptId = await this.matchBachsAttempt(event);
    if (!attemptId) return this.unmatchedBachs(event);
    await this.database.db.transaction((tx) =>
      enqueueOutbox(tx, {
        eventType: 'payment.reversed',
        aggregateId: attemptId,
        // Dedupe keys allow word characters, dots and dashes only.
        dedupeSuffix: event.eventId.replace(/[^\w.-]/g, '_'),
        payload: { attemptId, eventType: event.eventType },
      }),
    );
    return 'reversal_flagged';
  }

  /**
   * An account or capability event is only a trigger: the account is read back from Bachs and
   * that answer decides readiness, so a later restriction stops new checkouts. Repeats re-read.
   */
  private async refreshBachsAccount(
    event: Extract<NormalizedProviderEvent, { kind: 'account' }>,
    accounts?: Partial<Pick<BachsProvider, 'getRecipientAccount'>>,
  ): Promise<string> {
    const { db } = this.database;
    const known = await findPaymentAccountByReference(db, {
      provider: 'bachs',
      environment: 'sandbox',
      providerAccountReference: event.accountReference,
    });
    if (!known || !accounts?.getRecipientAccount)
      return this.unmatchedBachs(event);
    // A failed read throws, so Bachs retries the delivery later.
    const remote = await accounts.getRecipientAccount(event.accountReference);
    const { status, chargesEnabled } = bachsAccountReadiness(remote);
    await updatePaymentAccountStatus(db, {
      sealing: this.sealing,
      profileId: known.profileId,
      provider: 'bachs',
      environment: 'sandbox',
      providerAccountReference: remote.accountReference,
      status,
      chargesEnabled,
      payoutsEnabled: false,
      feeCollector: remote.feeCollector,
      requirementsDue: remote.requirementsDue,
    });
    return 'account_refreshed';
  }

  private async unmatchedBachs(
    event: NormalizedProviderEvent,
  ): Promise<string> {
    await recordUnmatchedEvent(this.database.db, {
      provider: 'bachs',
      providerEventId: event.eventId,
      eventType: event.eventType,
      payload: event,
      reason: 'unknown_attempt',
    });
    return 'unmatched';
  }
}
