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
  applyProRefundEvent,
  recordSavedCard,
  confirmProCheckout,
  endProForReversal,
  findProPurchaseByReference,
  flagPaymentReversal,
  recordProEvent,
  type ProVerified,
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
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import type { EventResult, MailSealing } from '@tipme/database';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { PAYMENT_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';

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
    // Paid Pro: the public page changes with the plan. Optional, as above.
    @Optional()
    @Inject(ProfileRevalidator)
    private readonly revalidator: Pick<
      ProfileRevalidator,
      'revalidate'
    > | null = null,
    // The pretend provider, to read a pretend Pro payment back as Bachs' would be.
    @Optional()
    @Inject(PAYMENT_PROVIDER_TOKEN)
    private readonly mockProvider: {
      verifyTransaction(reference: string): Promise<ProVerified>;
    } | null = null,
    // REFUND_FEE_RETURN (owner, 12 Nov 2026). Optional, as above: without it nothing is returned.
    @Optional()
    @Inject(API_CONFIG)
    private readonly config: Pick<ApiConfig, 'REFUND_FEE_RETURN'> | null = null,
  ) {}

  /** After a Pro payment changed a page's plan: its public page and open tabs re-read. */
  private signalPlan(result: {
    planChanged: boolean;
    profileId: string;
    handleLower: string | null;
  }): void {
    if (!result.planChanged) return;
    if (result.handleLower) this.revalidator?.revalidate(result.handleLower);
    void this.publishLive({
      to: { profile: result.profileId },
      type: 'profile.changed',
    });
  }

  /**
   * Paid Pro (ADR-0015): an event about a purchase on TipMe's own account. It is stored against the
   * purchase (once per partner event) and only triggers a read-back, which decides. A refund or
   * dispute is flagged to staff; a paid refund or a lost dispute ends that Pro month.
   */
  private async applyProEvent(
    event: Extract<NormalizedProviderEvent, { kind: 'payment' | 'reversal' }>,
    provider: string,
    reader: {
      verifyTransaction(reference: string): Promise<ProVerified>;
    } | null,
  ): Promise<string> {
    const { db } = this.database;
    const purchaseId = await findProPurchaseByReference(db, {
      provider,
      providerReference: event.providerReference,
      operationReference: event.operationReference,
      chargeReference: event.chargeReference ?? null,
    });
    if (!purchaseId) return this.unmatchedPro(event, provider);
    const { eventRowId } = await recordProEvent(db, {
      provider,
      providerEventId: event.eventId,
      eventType: event.eventType,
      purchaseId,
      payload: event,
    });
    const now = new Date();
    // A refund's own events (plan Task 9): only refund.paid books it and ends that month.
    if (event.kind === 'reversal' && event.refundState) {
      const result = await applyProRefundEvent(db, {
        purchaseId,
        eventRowId,
        refundState: event.refundState,
        partnerRefundId: event.partnerReversalId,
        operationReference: event.operationReference,
        refundedMinor: event.refundedMinor,
        refundFeeMinor: event.refundFeeMinor,
        now,
      });
      this.signalPlan(result);
      return `pro_refund_${result.outcome}`;
    }
    if (event.kind === 'reversal') {
      const endPro =
        event.refundState === 'paid' ||
        (!event.disputeWon && /chargeback|\.lost$/.test(event.eventType));
      this.signalPlan(
        await endProForReversal(db, { purchaseId, eventRowId, endPro, now }),
      );
      return 'pro_reversed';
    }
    if (!reader || !event.providerReference) return 'pro_stored';
    // A failed read throws: the partner delivers the event again, and reconciliation asks too.
    const verified = await reader.verifyTransaction(event.providerReference);
    const result = await confirmProCheckout(db, {
      purchaseId,
      verified,
      now,
      sealing: this.sealing,
      providerEventRowId: eventRowId,
    });
    this.signalPlan(result);
    return `pro_${result.outcome}`;
  }

  private async unmatchedPro(
    event: { eventId: string; eventType: string },
    provider: string,
  ): Promise<string> {
    await recordUnmatchedEvent(this.database.db, {
      provider,
      providerEventId: event.eventId,
      eventType: event.eventType,
      payload: event,
      reason: 'unknown_attempt',
    });
    return 'unmatched';
  }

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
    // Paid Pro on pretend money: the same path as TipMe's own Bachs account.
    if (
      (reference.startsWith('mock_pro_') ||
        reference.startsWith('mock_charge_')) &&
      event.type.startsWith('payment.')
    )
      return this.applyProEvent(
        {
          kind: 'payment',
          eventId: event.id,
          eventType: event.type,
          scope: 'platform',
          providerReference: reference,
          operationReference: null,
          accountReference: null,
          status: 'pending',
          feePaidBy: 'unknown',
        },
        PROVIDER,
        this.mockProvider,
      );
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
    // Auto-renew (plan Task 10): a card saved on TipMe's own account. Only an opted-in customer
    // turns auto-renew on; any other is unmatched.
    if (event.kind === 'saved_method') {
      const profileId = await recordSavedCard(this.database.db, {
        provider: 'bachs',
        customerReference: event.customerReference,
        paymentMethodReference: event.paymentMethodReference,
        now: new Date(),
      });
      return profileId ? 'pro_card_saved' : this.unmatchedBachs(event);
    }
    // TipMe's own account (paid Pro): never a tip, never an account of a recipient.
    if (
      (event.kind === 'payment' || event.kind === 'reversal') &&
      event.scope === 'platform'
    )
      return this.applyProEvent(
        event,
        'bachs',
        bachs.verifyTransaction
          ? {
              verifyTransaction: (reference) =>
                bachs.verifyTransaction!(reference),
            }
          : null,
      );
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
      ...(this.config?.REFUND_FEE_RETURN ? { feeReturnOn: true } : {}),
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
    // A business's receive-only account: re-read when its owner opens the Money section.
    if (known.profileId === null) return 'ignored';
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
    // After the account's status (and its payout setup) committed: Settings and the notices re-read.
    void this.publishLive({
      to: { profile: known.profileId },
      type: 'payments.changed',
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
