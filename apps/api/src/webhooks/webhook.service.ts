import { Inject, Injectable, Optional } from '@nestjs/common';
import type { MockWebhook } from '@tipme/contracts';
import {
  bachsAccountReadiness,
  type BachsProvider,
  type NormalizedProviderEvent,
} from '@tipme/payments';
import { z } from 'zod';
import {
  applyPayoutSignal,
  flagPaymentReversal,
  findBachsAttemptByOperationReference,
  ensurePayoutSetup,
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
import type { Logger } from '@tipme/observability';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import type { EventResult, MailSealing } from '@tipme/database';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';

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
    @Inject(LOGGER) private readonly logger: Pick<Logger, 'warn'>,
    // Optional: integration tests build this service by hand, without the live module.
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  /**
   * After a provider event moved a tip to "still being confirmed": its page's dashboards re-read.
   * Called once recordProviderEvent has resolved, so outside its transaction. A paid or failed tip
   * is signalled by the outbox relay instead.
   */
  private signalPending(result: EventResult): void {
    if (
      result.outcome === 'applied' &&
      result.tipStatus === 'PENDING_VERIFICATION'
    )
      void this.publishLive({
        to: { profile: result.profileId },
        type: 'tips.changed',
      });
  }

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
      this.signalPending(result);
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

  /**
   * `bachs` is the adapter that verified the event: its environment decides which accounts the
   * event can match, so a live event never touches a sandbox row or the reverse.
   */
  async applyBachs(
    event: NormalizedProviderEvent,
    bachs: Pick<BachsProvider, 'environment'> &
      Partial<
        Pick<
          BachsProvider,
          'getRecipientAccount' | 'verifyTransaction' | 'fetchPayoutStatus'
        >
      >,
  ): Promise<string> {
    if (event.kind === 'ignored') return 'ignored';
    if (event.kind === 'payout') return this.applyBachsPayout(event, bachs);
    const { environment } = bachs;
    if (event.kind === 'account') return this.refreshBachsAccount(event, bachs);
    if (event.kind === 'reversal')
      return this.flagBachsReversal(event, environment);
    const { providerReference } = event;
    const attemptId = await this.matchBachsAttempt(event, environment);
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
      this.signalPending(result);
      // The webhook only proves something happened; read the payment back from Bachs now, with
      // the worker's own checks (quoted share, fee bearer), so the receipt turns paid at once.
      // A failed read changes nothing: the worker keeps checking.
      if (bachs.verifyTransaction) {
        const { verifyTransaction } = bachs;
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

  /**
   * A payout event for an account of ours. One TipMe has no reference for yet may be answering a
   * start still in flight, so it is parked for reconciliation rather than called unexpected.
   */
  private async applyBachsPayout(
    event: Extract<NormalizedProviderEvent, { kind: 'payout' }>,
    bachs: Pick<BachsProvider, 'environment'> &
      Partial<Pick<BachsProvider, 'fetchPayoutStatus'>>,
  ): Promise<string> {
    const { db } = this.database;
    const account = await findPaymentAccountByReference(db, {
      provider: 'bachs',
      environment: bachs.environment,
      providerAccountReference: event.accountReference,
    });
    if (!account) return this.unmatchedBachs(event);
    const payoutId = await findPayoutByReference(
      db,
      'bachs',
      event.providerReference,
    );
    if (!payoutId) {
      await recordUnmatchedEvent(db, {
        provider: 'bachs',
        providerEventId: event.eventId,
        eventType: event.eventType,
        payload: event,
        reason: 'unknown_payout',
      });
      return 'parked';
    }
    return applyPayoutSignal(db, {
      payoutId,
      providerReference: event.providerReference,
      eventId: event.eventId,
      status: event.status,
      contradicted: event.contradicted === true,
      claims: {
        ...(event.amountMinor === undefined
          ? {}
          : { amountMinor: event.amountMinor }),
        ...(event.currency === undefined ? {} : { currency: event.currency }),
        ...(event.operationReference
          ? { operationReference: event.operationReference }
          : {}),
      },
      ...(event.feeMinor === undefined ? {} : { feeMinor: event.feeMinor }),
      reader: bachs,
      payload: event,
      now: new Date(),
    });
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
  private async matchBachsAttempt(
    event: {
      accountReference: string | null;
      operationReference: string | null;
      providerReference: string | null;
    },
    environment: BachsProvider['environment'],
  ): Promise<string | null> {
    const { accountReference, operationReference, providerReference } = event;
    if (!accountReference || !providerReference) return null;
    if (operationReference) {
      if (!z.uuid().safeParse(operationReference).success) return null;
      return findBachsAttemptByOperationReference(this.database.db, {
        attemptId: operationReference,
        accountReference,
        environment,
      });
    }
    return findBachsAttemptByReference(this.database.db, {
      providerReference,
      accountReference,
      environment,
    });
  }

  /**
   * Refunds and disputes raise a money issue for staff, once per partner refund or dispute, and
   * pause that recipient's withdrawals. They never change a balance or the ledger here: staff
   * reverse a paid refund from the issue (`tip.reverse`, business release 2).
   */
  private async flagBachsReversal(
    event: Extract<NormalizedProviderEvent, { kind: 'reversal' }>,
    environment: BachsProvider['environment'],
  ): Promise<string> {
    const attemptId = await this.matchBachsAttempt(event, environment);
    if (!attemptId) return this.unmatchedBachs(event);
    const flagged = await flagPaymentReversal(this.database.db, {
      attemptId,
      eventId: event.eventId,
      eventType: event.eventType,
      partnerReversalId: event.partnerReversalId,
      disputeWon: event.disputeWon,
      refundState: event.refundState,
      refundedMinor: event.refundedMinor,
      refundFeeMinor: event.refundFeeMinor,
    });
    return flagged === 'dispute_won' ? 'dispute_won' : 'reversal_flagged';
  }

  /**
   * An account or capability event is only a trigger: the account is read back from Bachs and
   * that answer decides readiness, so a later restriction stops new checkouts. Repeats re-read.
   */
  private async refreshBachsAccount(
    event: Extract<NormalizedProviderEvent, { kind: 'account' }>,
    accounts: Pick<BachsProvider, 'environment'> &
      Partial<
        Pick<
          BachsProvider,
          | 'getRecipientAccount'
          | 'name'
          | 'setManualPayouts'
          | 'payoutCapability'
          | 'requestPayoutCapabilities'
          | 'payoutDestinationStatus'
        >
      >,
  ): Promise<string> {
    const { db } = this.database;
    const { environment } = accounts;
    const known = await findPaymentAccountByReference(db, {
      provider: 'bachs',
      environment,
      providerAccountReference: event.accountReference,
    });
    if (!known || !accounts.getRecipientAccount)
      return this.unmatchedBachs(event);
    // A failed read throws, so Bachs retries the delivery later.
    const remote = await accounts.getRecipientAccount(event.accountReference);
    const { status, chargesEnabled } = bachsAccountReadiness(remote);
    await updatePaymentAccountStatus(db, {
      sealing: this.sealing,
      profileId: known.profileId,
      provider: 'bachs',
      environment,
      providerAccountReference: remote.accountReference,
      status,
      chargesEnabled,
      payoutsEnabled: false,
      feeCollector: remote.feeCollector,
      requirementsDue: remote.requirementsDue,
    });
    // A failure here is left for the worker's sweep: retrying the delivery would not help it.
    if (
      accounts.name &&
      accounts.setManualPayouts &&
      accounts.payoutCapability &&
      accounts.requestPayoutCapabilities &&
      accounts.payoutDestinationStatus
    )
      await ensurePayoutSetup(db, {
        profileId: known.profileId,
        provider: {
          name: accounts.name,
          environment,
          setManualPayouts: accounts.setManualPayouts,
          payoutCapability: accounts.payoutCapability,
          requestPayoutCapabilities: accounts.requestPayoutCapabilities,
          payoutDestinationStatus: accounts.payoutDestinationStatus,
        },
        log: (entry) => this.logger?.warn(entry),
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
