import { Inject, Injectable, Optional } from '@nestjs/common';
import { proChanged, tipChanged, type MockWebhook } from '@tipme/contracts';
import {
  bachsAccountReadiness,
  disputeAsReversal,
  type BachsProvider,
  type NormalizedProviderEvent,
} from '@tipme/payments';
import { z } from 'zod';
import {
  applyDisputeEvent,
  applyPayoutSignal,
  applyProRefundEvent,
  applyTipRefundEvent,
  findTipRefund,
  tipRefundIdOf,
  recordSavedCard,
  confirmProCheckout,
  endProForReversal,
  findProPurchaseByReference,
  flagPaymentReversal,
  recordProEvent,
  type ProVerified,
  findBachsAttemptByOperationReference,
  ensurePayoutSetup,
  featureOn,
  findPaymentAccountByReference,
  paymentAccountSetupInFlight,
  updatePaymentAccountStatus,
  findBachsAttemptByReference,
  findAttemptByReference,
  findAttemptStart,
  findPayoutByReference,
  hasWaitingCollectTransfers,
  matchCollectAttempt,
  OperationError,
  reconcileAttempts,
  recordPayoutOutcome,
  recordProviderEvent,
  recordUnmatchedEvent,
  releaseWaitingTransfers,
  collectBankFacts,
  settleCollectVerification,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import type { EventResult, MailSealing } from '@tipme/database';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { PAYMENT_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';
import { AccountSetupInFlightError } from './retryable.js';

const PROVIDER = 'mock';

/**
 * How long after its claim an account setup still holds back account events for unknown
 * references. A setup is two partner calls of at most 10 s each (the client's timeout) before
 * the reference is saved, so a real one is over in well under a minute; 10 minutes leaves room
 * for a slow one and covers the partner's first two retries (about 1 and 6 minutes after the
 * first try). A claim left CREATING longer (a crash mid-setup, which the worker's sweep marks
 * UNKNOWN for staff) stops holding events back, so its events are recorded, not retried for ever.
 */
const ACCOUNT_SETUP_WINDOW_MS = 10 * 60_000;

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
  ) {}

  /** After a Pro payment changed a page's plan: its public page and open tabs re-read. */
  private signalPlan(result: {
    planChanged: boolean;
    /** Null for a business's purchase (Business Pro): no page changed. */
    profileId: string | null;
    handleLower: string | null;
  }): void {
    if (!result.planChanged || result.profileId === null) return;
    if (result.handleLower) this.revalidator?.revalidate(result.handleLower);
    void this.publishLive({
      to: { profile: result.profileId },
      type: 'profile.changed',
    });
  }

  /**
   * After this call settled a Pro purchase (it left PENDING, COLLECTING or UNKNOWN, whatever the
   * outcome): the buyer's open Settings re-read it (addendum §3.7). A business's purchase has no
   * page. Called once confirmProCheckout has resolved, so after its commit; never awaited.
   */
  private signalPurchase(result: {
    settled: boolean;
    profileId: string | null;
  }): void {
    if (!result.settled || result.profileId === null) return;
    void this.publishLive(proChanged(result.profileId));
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
    /**
     * A platform dispute the partner ruled against TipMe (`dispute.updated`, status lost), which
     * reaches Pro in the reversal shape: it ends Pro as a `*.lost` event does (Task 9).
     */
    disputeLost = false,
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
        (!event.disputeWon &&
          (disputeLost || /chargeback|\.lost$/.test(event.eventType)));
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
    this.signalPurchase(result);
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
   * After a provider event moved a tip to "still being confirmed": its page's dashboards and its
   * open receipt re-read. Called once recordProviderEvent has resolved, so outside its
   * transaction. A paid or failed tip is signalled by the outbox relay instead.
   */
  private signalPending(result: EventResult): void {
    if (
      result.outcome !== 'applied' ||
      result.tipStatus !== 'PENDING_VERIFICATION'
    )
      return;
    void this.publishLive({
      to: { profile: result.profileId },
      type: 'tips.changed',
    });
    void this.publishLive(tipChanged(result.tipId));
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
    // You collect (plan Task 5): the pretend partner's disputes and capability changes are stored
    // for review until Task 9 routes them; they never reach the payout path below.
    if (!event.type.startsWith('payout.'))
      return this.unmatched(event, 'unknown_attempt');
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
    // You collect (plan Task 7, R2, P6). TipMe's own account carries Pro purchases and collect tips.
    // A refund TipMe asked for is matched by its own reference first, so it always reaches the tip
    // refund and never a payment or Pro. Then a collect tip is matched; only an event that matches
    // none goes to Pro billing, as before.
    if (event.kind === 'reversal' && event.scope === 'platform') {
      const refunded = await this.applyTipRefund(event);
      if (refunded) return refunded;
    }
    let disputeLost = false;
    if (event.kind === 'dispute') {
      // A collect tip's dispute is TipMe's (plan Task 9): modelled, held and recovered there.
      if (await this.matchCollect(event)) {
        const { outcome } = await applyDisputeEvent(this.database.db, {
          event,
          provider: 'bachs',
          now: new Date(),
        });
        return `dispute_${outcome}`;
      }
      // Task 5 (P5): one that matches no tip reaches Pro billing in today's reversal shape. A lost
      // one ends Pro, as a `*.lost` event always did (Task 9 closes that gap).
      disputeLost = event.status === 'lost';
      event = disputeAsReversal(event);
    }
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
    // TipMe's own account: a collect tip's, or else paid Pro's; never a recipient's account.
    if (
      (event.kind === 'payment' || event.kind === 'reversal') &&
      event.scope === 'platform'
    ) {
      const attemptId = await this.matchCollect(event);
      if (attemptId)
        return event.kind === 'payment'
          ? this.applyCollectPayment(event, attemptId, bachs)
          : // A refund or dispute TipMe did not ask for (Tasks 9 and 10 model them): for staff.
            this.storeCollectEvent(event);
      return this.applyProEvent(
        event,
        'bachs',
        bachs.verifyTransaction
          ? {
              verifyTransaction: (reference) =>
                bachs.verifyTransaction!(reference),
            }
          : null,
        disputeLost,
      );
    }
    if (event.kind === 'payout') return this.applyBachsPayout(event, bachs);
    const { environment } = bachs;
    if (event.kind === 'account') return this.refreshBachsAccount(event, bachs);
    if (event.kind === 'reversal')
      return this.flagBachsReversal(event, environment);
    const { providerReference } = event;
    const attemptId = await this.matchBachsAttempt(event, environment);
    if (!attemptId || !providerReference) return this.unmatchedBachs(event);
    return this.applyTipPayment(event, attemptId, providerReference, bachs);
  }

  /** R2: the collect tip a platform-scoped event is about, by TipMe's reference, checkout or charge. */
  private matchCollect(event: {
    providerReference: string | null;
    operationReference: string | null;
    chargeReference?: string | null;
  }): Promise<string | null> {
    return matchCollectAttempt(this.database.db, {
      providerReference: event.providerReference,
      operationReference: event.operationReference,
      chargeReference: event.chargeReference ?? null,
    });
  }

  /**
   * A payment event for a collect tip, on TipMe's own checkout: the tip path, as a direct tip's. The
   * attempt's own checkout reference is used, so an event naming only the charge matches it too.
   */
  private async applyCollectPayment(
    event: Extract<NormalizedProviderEvent, { kind: 'payment' }>,
    attemptId: string,
    bachs: Pick<BachsProvider, 'environment'> &
      Partial<Pick<BachsProvider, 'verifyTransaction'>>,
  ): Promise<string> {
    const stored = await findAttemptStart(this.database.db, attemptId);
    const named = event.providerReference?.startsWith('platform:')
      ? event.providerReference
      : null;
    // An event naming another checkout than the attempt's own is never applied to it.
    if (stored?.reference && named && named !== stored.reference)
      return this.unmatchedBachs(event);
    const providerReference = stored?.reference ?? named;
    if (!providerReference) return this.unmatchedBachs(event);
    return this.applyTipPayment(event, attemptId, providerReference, bachs);
  }

  /**
   * A collect tip's refund (or a dispute event the adapter could not read) that TipMe does not model
   * yet (plan Task 10; Task 9 models readable disputes): kept for
   * staff as its own kind of unmatched event (the issues inbox raises it), and never sent to Pro
   * billing or the payment path. Nothing is booked.
   */
  private async storeCollectEvent(
    event: NormalizedProviderEvent,
  ): Promise<string> {
    await recordUnmatchedEvent(this.database.db, {
      provider: 'bachs',
      providerEventId: event.eventId,
      eventType: event.eventType,
      payload: event,
      reason: 'collect_event',
    });
    return 'collect_event_stored';
  }

  /**
   * The tip path for a payment event: stored once against the attempt, then the payment is read back
   * from the partner with the worker's own checks, so the receipt turns paid at once.
   */
  private async applyTipPayment(
    event: Extract<NormalizedProviderEvent, { kind: 'payment' }>,
    attemptId: string,
    providerReference: string,
    bachs: Pick<BachsProvider, 'environment'> &
      Partial<Pick<BachsProvider, 'verifyTransaction'>>,
  ): Promise<string> {
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
        const { verifyTransaction, environment } = bachs;
        const checked = await reconcileAttempts({
          db: this.database.db,
          provider: {
            environment,
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
      provider: 'bachs',
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
   * A refund TipMe asked for (staff "Refund tip", owner 14 Nov 2026): the partner repeats TipMe's
   * reference, and its refund.paid books it. Not a staff money issue: two staff already approved it.
   * From a recipient's account (a direct tip) or TipMe's own (a collect tip, P6). Null when the event
   * is not one.
   */
  private async applyTipRefund(
    event: Extract<NormalizedProviderEvent, { kind: 'reversal' }>,
  ): Promise<string | null> {
    const tipRefundId = tipRefundIdOf(event.operationReference);
    if (!tipRefundId || !event.refundState) return null;
    const known = await findTipRefund(this.database.db, tipRefundId);
    if (!known) return this.unmatchedBachs(event);
    const outcome = await applyTipRefundEvent(this.database.db, {
      tipRefundId,
      refundState: event.refundState,
      partnerReversalId: event.partnerReversalId,
      refundedMinor: event.refundedMinor,
      refundFeeMinor: event.refundFeeMinor,
      now: new Date(),
    });
    return `tip_refund_${outcome}`;
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
    const refunded = await this.applyTipRefund(event);
    if (refunded) return refunded;
    const attemptId = await this.matchBachsAttempt(event, environment);
    if (!attemptId) return this.unmatchedBachs(event);
    // The `refund_fee_return` switch (owner, 12 and 14 Nov 2026): with it on, a final refund is
    // recorded in the ledger at once instead of waiting for two staff.
    const feeReturnOn = await featureOn(this.database.db, 'refund_fee_return');
    const flagged = await flagPaymentReversal(this.database.db, {
      attemptId,
      eventId: event.eventId,
      eventType: event.eventType,
      partnerReversalId: event.partnerReversalId,
      disputeWon: event.disputeWon,
      refundState: event.refundState,
      refundedMinor: event.refundedMinor,
      refundFeeMinor: event.refundFeeMinor,
      ...(feeReturnOn ? { feeReturnOn: true } : {}),
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
    if (!known) return this.unknownBachsAccount(event, environment);
    if (!accounts.getRecipientAccount) return this.unmatchedBachs(event);
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
    await this.settleCollect(
      known.profileId,
      remote.accountReference,
      accounts,
    );
    // After the account's status (and its payout setup) committed: Settings and the notices re-read.
    void this.publishLive({
      to: { profile: known.profileId },
      type: 'payments.changed',
    });
    return 'account_refreshed';
  }

  /**
   * You collect (plan Task 13, P12): a recipient whose bank check hasn't finished is checked again
   * (a bank under review read, the capability read), and verified once both say so, which releases
   * their shares. Anyone else goes on as Task 8 has it. A failure is left for the next event or
   * visit, never a reason to refuse the delivery.
   */
  private async settleCollect(
    profileId: string,
    accountReference: string,
    accounts: Partial<
      Pick<
        BachsProvider,
        'name' | 'payoutCapability' | 'payoutDestinationStatus'
      >
    >,
  ): Promise<void> {
    const { db } = this.database;
    const { name, payoutCapability, payoutDestinationStatus } = accounts;
    try {
      const facts = await collectBankFacts(db, profileId);
      if (
        facts.mode === 'collect' &&
        !facts.verifiedAt &&
        name &&
        payoutCapability &&
        payoutDestinationStatus
      ) {
        await settleCollectVerification(db, {
          profileId,
          provider: {
            name,
            payoutCapability: (ref) => payoutCapability.call(accounts, ref),
            payoutDestinationStatus: (ref, dest) =>
              payoutDestinationStatus.call(accounts, ref, dest),
          },
          accountReference,
          sealing: this.sealing,
          now: new Date(),
          log: (entry) => this.logger?.warn(entry),
        });
        return;
      }
    } catch (error) {
      this.logger?.warn({
        event: 'collect_bank.settle_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }
    await this.releaseCollectShares(profileId, accountReference, accounts);
  }

  /**
   * You collect (plan Task 8, spec §5): a recipient's held shares start moving once their account
   * can receive transfers. The event only triggers it: the account's `transfers` capability is read
   * now, and that answer decides, so an older event delivered after a newer one can't release
   * shares the account can't take. Only worth the read with shares waiting. A failure is left for
   * the worker's sweep (it releases them after their wait), never a reason to refuse the delivery.
   */
  private async releaseCollectShares(
    profileId: string,
    accountReference: string,
    accounts: Partial<Pick<BachsProvider, 'payoutCapability'>>,
  ): Promise<void> {
    if (!accounts.payoutCapability) return;
    const { db } = this.database;
    try {
      if (!(await hasWaitingCollectTransfers(db, profileId))) return;
      const { status } = await accounts.payoutCapability(accountReference);
      if (status !== 'active') return;
      await releaseWaitingTransfers(db, { profileId, now: new Date() });
    } catch (error) {
      this.logger?.warn({
        event: 'collect_transfers.release_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /**
   * An account event for a reference TipMe has no account for. The partner sends account events
   * while an account is still being created, before the onboarding request has saved its
   * reference; while any setup in this environment is in flight the event is refused as
   * retryable, so it comes back once the reference is saved and then matches normally.
   *
   * The partner's webhook docs (https://docs.bachs.io/guides/webhooks, read 15 Nov 2026): a
   * delivery succeeds only on a 2xx within 10 seconds; timeouts, 5xx, 408 and 429 are retried,
   * other 4xx are not. Up to 5 tries: retries about 1, 5, 15 and 60 minutes after each failed
   * one (the last about 80 minutes after the first), then it stops. So the controller answers
   * 503 (the same as a database outage).
   *
   * Otherwise the account is not one of ours (or its setup ended without one): the event is kept
   * for audit as `unknown_account`, which is not raised to staff, since it only ever triggers a
   * read-back and there is nothing for a person to do.
   */
  private async unknownBachsAccount(
    event: Extract<NormalizedProviderEvent, { kind: 'account' }>,
    environment: BachsProvider['environment'],
  ): Promise<string> {
    const { db } = this.database;
    if (
      await paymentAccountSetupInFlight(db, {
        provider: 'bachs',
        environment,
        claimedSince: new Date(Date.now() - ACCOUNT_SETUP_WINDOW_MS),
      })
    )
      throw new AccountSetupInFlightError();
    await recordUnmatchedEvent(db, {
      provider: 'bachs',
      providerEventId: event.eventId,
      eventType: event.eventType,
      payload: event,
      reason: 'unknown_account',
    });
    return 'unmatched';
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
