import { createHash } from 'node:crypto';
import {
  ATTEMPT_TRANSITIONS,
  buildCollectPaymentPosting,
  buildPaymentPosting,
  canTransition,
  formatMinor,
  TIP_TRANSITIONS,
} from '@tipme/domain';
import type { AttemptStatus, TipStatus } from '@tipme/domain';
import { recordedProviderName } from '@tipme/contracts';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  feeFreeCredits,
  paymentAttempts,
  paymentIntents,
  providerEvents,
  tipBusinessShares,
  tipQuotes,
  tips,
} from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';
import { enqueueOutbox } from './outbox.js';
import { recordTransition } from './transitions.js';
import { scheduleCollectSweep, scheduleShareSweep } from './share-transfers.js';
import { scheduleCollectTransfer } from './collect-transfers.js';
import { personOf } from './owner.js';

/** A provider message about a payment. Only signature-verified events may reach this function. */
export interface PaymentEvent {
  provider: string;
  providerEventId: string;
  eventType: 'payment.succeeded' | 'payment.failed' | 'payment.pending';
  attemptId: string;
  providerReference: string;
  amountMinor?: bigint;
  currency?: string;
  providerFeeMinor?: bigint;
  /**
   * You collect: the partner environment the payment was read in, and the partner's charge its
   * read-back named. Both are kept on a collect tip's transfer; a direct tip ignores them. A collect
   * tip on Bachs is never booked without the environment (the whole event rolls back); any other
   * provider is the pretend one, whose money is `sandbox`.
   */
  environment?: 'sandbox' | 'live';
  chargeReference?: string | null;
  signatureVerified: true;
  payload: unknown;
  traceId?: string | null;
  now?: Date;
}

export type EventOutcome =
  'applied' | 'duplicate' | 'ignored' | 'mismatch' | 'conflict';

export interface EventResult {
  outcome: EventOutcome;
  tipStatus: string;
  attemptStatus: string;
  /** The tip's page, so a caller can signal it after the commit (additive). */
  profileId: string;
}

interface Locked {
  attempt: {
    id: string;
    status: AttemptStatus;
    provider: string | null;
    providerReference: string | null;
  };
  tip: { id: string; status: TipStatus; profileId: string; currency: string };
  quote: {
    payerTotalMinor: bigint;
    platformFeeMinor: bigint;
    providerFeeMinor: bigint;
    recipientNetMinor: bigint;
    tipMinor: bigint;
    waivedPlatformFeeMinor: bigint;
    /** You collect (R7): fixed on the quote; never the profile's mode now. */
    collectionMode: string;
  };
}

async function lock(tx: Tx, attemptId: string): Promise<Locked | null> {
  const [attempt] = await tx
    .select({
      id: paymentAttempts.id,
      status: paymentAttempts.status,
      provider: paymentAttempts.provider,
      intentId: paymentAttempts.intentId,
      providerReference: paymentAttempts.providerReference,
    })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId))
    .for('update');
  if (!attempt) return null;
  const [tip] = await tx
    .select({
      id: tips.id,
      status: tips.status,
      profileId: tips.profileId,
      currency: tips.currency,
    })
    .from(tips)
    .where(eq(tips.intentId, attempt.intentId))
    .for('update');
  const [quote] = await tx
    .select({
      payerTotalMinor: tipQuotes.payerTotalMinor,
      platformFeeMinor: tipQuotes.platformFeeMinor,
      providerFeeMinor: tipQuotes.providerFeeMinor,
      recipientNetMinor: tipQuotes.recipientNetMinor,
      tipMinor: tipQuotes.tipMinor,
      waivedPlatformFeeMinor: tipQuotes.waivedPlatformFeeMinor,
      collectionMode: tipQuotes.collectionMode,
    })
    .from(paymentIntents)
    .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
    .where(eq(paymentIntents.id, attempt.intentId));
  if (!tip || !quote) return null;
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      provider: attempt.provider,
      providerReference: attempt.providerReference,
    },
    // A team tip (R2-D) has no person and is posted by its own PR; until then it stops here.
    tip: { ...tip, profileId: personOf(tip.profileId) },
    quote,
  };
}

/**
 * The only path to a paid tip. In one transaction: store the event (unique per provider event ID),
 * lock the attempt and tip, apply an allowed transition (never a downgrade), and on success post
 * the balanced ledger transaction and the outbox event. Anything surprising is kept and flagged.
 */
export async function recordProviderEvent(
  db: Database,
  event: PaymentEvent,
): Promise<EventResult> {
  const traceId = event.traceId ?? activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      // Lock the attempt BEFORE inserting the event: the event's foreign key takes a KEY SHARE lock
      // on the attempt, and upgrading to FOR UPDATE afterwards deadlocks with a concurrent event.
      const [known] = await tx
        .select({
          id: paymentAttempts.id,
          provider: paymentAttempts.provider,
          providerReference: paymentAttempts.providerReference,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, event.attemptId))
        .for('update');
      if (!known) throw new OperationError('ATTEMPT_NOT_FOUND');
      if (
        (known.provider !== null && known.provider !== event.provider) ||
        (known.providerReference !== null &&
          known.providerReference !== event.providerReference)
      )
        throw new OperationError('INVALID_INPUT');

      const payload = jsonSafe(event.payload);
      const payloadHash = createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
      const eventRowId = newId();
      const stored = await tx
        .insert(providerEvents)
        .values({
          id: eventRowId,
          provider: event.provider,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          signatureVerified: event.signatureVerified,
          payloadHash,
          payload,
          attemptId: event.attemptId,
        })
        .onConflictDoNothing({
          target: [providerEvents.provider, providerEvents.providerEventId],
        })
        .returning({ id: providerEvents.id });

      const state = await lock(tx, event.attemptId);
      if (!state) throw new OperationError('ATTEMPT_NOT_FOUND');
      if (stored.length === 0) {
        // Same provider event ID: a true duplicate, unless its content changed (flag that).
        const [original] = await tx
          .select({
            id: providerEvents.id,
            eventType: providerEvents.eventType,
            payloadHash: providerEvents.payloadHash,
          })
          .from(providerEvents)
          .where(
            and(
              eq(providerEvents.provider, event.provider),
              eq(providerEvents.providerEventId, event.providerEventId),
            ),
          );
        const changed =
          original &&
          (original.eventType !== event.eventType ||
            original.payloadHash !== payloadHash);
        if (original && changed) {
          await enqueueOutbox(tx, {
            eventType: 'provider_event.conflict',
            aggregateId: original.id,
            dedupeSuffix: eventRowId,
            payload: {
              providerEventRowId: original.id,
              attemptId: state.attempt.id,
            },
          });
        }
        return {
          outcome: changed ? ('conflict' as const) : ('duplicate' as const),
          tipStatus: state.tip.status,
          attemptStatus: state.attempt.status,
          profileId: state.tip.profileId,
        };
      }

      const outcome = await apply(tx, event, state, eventRowId, traceId);
      await tx
        .update(providerEvents)
        .set({
          processedAt: event.now ?? new Date(),
          processingOutcome: outcome,
        })
        .where(eq(providerEvents.id, eventRowId));
      const after = await lock(tx, event.attemptId);
      return {
        outcome,
        tipStatus: after?.tip.status ?? state.tip.status,
        attemptStatus: after?.attempt.status ?? state.attempt.status,
        profileId: state.tip.profileId,
      };
    }),
  );
}

async function apply(
  tx: Tx,
  event: PaymentEvent,
  state: Locked,
  eventRowId: string,
  traceId: string | null,
): Promise<EventOutcome> {
  const { attempt, tip, quote } = state;
  const moveAttempt = async (to: AttemptStatus) => {
    // The provider reference is recorded once, from a verified event we act on (never from a
    // mismatched one), so the proof shows the reference that actually settled the attempt.
    const reference =
      to !== 'UNKNOWN' && attempt.providerReference === null
        ? {
            provider: event.provider,
            providerReference: event.providerReference,
          }
        : {};
    await tx
      .update(paymentAttempts)
      .set({ status: to, startClaimedAt: null, ...reference })
      .where(eq(paymentAttempts.id, attempt.id));
    await recordTransition(tx, {
      entityType: 'attempt',
      entityId: attempt.id,
      fromStatus: attempt.status,
      toStatus: to,
      cause: 'provider_event',
      providerEventId: eventRowId,
      traceId,
    });
  };
  const moveTip = async (to: TipStatus, completedAt?: Date) => {
    await tx
      .update(tips)
      .set({ status: to, ...(completedAt ? { completedAt } : {}) })
      .where(eq(tips.id, tip.id));
    await recordTransition(tx, {
      entityType: 'tip',
      entityId: tip.id,
      fromStatus: tip.status,
      toStatus: to,
      cause: 'provider_event',
      providerEventId: eventRowId,
      traceId,
    });
  };

  if (event.eventType === 'payment.pending') {
    if (!canTransition(ATTEMPT_TRANSITIONS, attempt.status, 'PENDING'))
      return 'ignored';
    await moveAttempt('PENDING');
    if (canTransition(TIP_TRANSITIONS, tip.status, 'PENDING_VERIFICATION'))
      await moveTip('PENDING_VERIFICATION');
    return 'applied';
  }

  if (event.eventType === 'payment.failed') {
    if (!canTransition(ATTEMPT_TRANSITIONS, attempt.status, 'VERIFIED_FAILED'))
      return 'ignored';
    await moveAttempt('VERIFIED_FAILED');
    if (canTransition(TIP_TRANSITIONS, tip.status, 'FAILED'))
      await moveTip('FAILED');
    await enqueueOutbox(tx, {
      eventType: 'tip.failed',
      aggregateId: tip.id,
      payload: { tipId: tip.id, profileId: tip.profileId },
    });
    return 'applied';
  }

  // payment.succeeded
  if (attempt.status === 'VERIFIED_SUCCEEDED') return 'ignored';
  if (
    !canTransition(ATTEMPT_TRANSITIONS, attempt.status, 'VERIFIED_SUCCEEDED') ||
    !canTransition(TIP_TRANSITIONS, tip.status, 'SUCCEEDED')
  ) {
    // The provider says it succeeded after a final failure, or for a tip that can no longer
    // succeed (e.g. cancelled): money may have been captured. Flag it; never book it.
    await enqueueOutbox(tx, {
      eventType: 'payment.conflict',
      aggregateId: attempt.id,
      dedupeSuffix: eventRowId,
      payload: {
        attemptId: attempt.id,
        tipId: tip.id,
        attemptStatus: attempt.status,
        tipStatus: tip.status,
      },
    });
    return 'conflict';
  }
  const { amountMinor, currency, providerFeeMinor } = event;
  if (
    amountMinor === undefined ||
    currency === undefined ||
    providerFeeMinor === undefined ||
    amountMinor !== quote.payerTotalMinor ||
    currency !== tip.currency ||
    providerFeeMinor < 0n ||
    providerFeeMinor > amountMinor
  ) {
    // Never book a misreported or tampered amount; hold for verified evidence.
    if (canTransition(ATTEMPT_TRANSITIONS, attempt.status, 'UNKNOWN'))
      await moveAttempt('UNKNOWN');
    await enqueueOutbox(tx, {
      eventType: 'payment.mismatch',
      aggregateId: attempt.id,
      dedupeSuffix: eventRowId,
      payload: { attemptId: attempt.id, tipId: tip.id },
    });
    return 'mismatch';
  }

  const now = event.now ?? new Date();
  await moveAttempt('VERIFIED_SUCCEEDED');
  await moveTip('SUCCEEDED', now);
  // A fee-free tip uses up one credit once it is paid (never below zero; a quoted fee-free tip is
  // honoured even if the credits ran out meanwhile).
  if (quote.waivedPlatformFeeMinor > 0n)
    await tx
      .update(feeFreeCredits)
      .set({ remaining: sql`${feeFreeCredits.remaining} - 1` })
      .where(
        and(
          eq(feeFreeCredits.profileId, tip.profileId),
          gt(feeFreeCredits.remaining, 0),
        ),
      );
  // Business release 2: a share fixed on the tip at intent time (only ever written for a tip made at
  // a membership, with the agreement in force; the database checks it) is the business's own line,
  // posted here in the payment's own transaction, so a paid tip never has one without the other.
  // It is honoured whatever the flags say now: the supporter was told about it before paying.
  const [share] = await tx
    .select({
      businessId: tipBusinessShares.businessId,
      amountMinor: tipBusinessShares.shareMinor,
    })
    .from(tipBusinessShares)
    .where(eq(tipBusinessShares.tipId, tip.id));
  const posting = {
    grossMinor: quote.tipMinor,
    platformFeeMinor: quote.platformFeeMinor,
    quotedProviderFeeMinor: quote.providerFeeMinor,
    actualProviderFeeMinor: providerFeeMinor,
    recipientNetMinor: quote.recipientNetMinor,
    profileId: tip.profileId,
    ...(share ? { businessShare: share } : {}),
  };
  const provider = recordedProviderName(event.provider);
  if (quote.collectionMode === 'collect') {
    // You collect (spec §4, R3): TipMe collected the tip on its own account, so the recipient's net
    // (and a business's share) is held there, booked under the same key. In this transaction too: the
    // one transfer of the recipient's part, and the business's leg in (its money is already here).
    await postLedgerTransaction(tx, {
      operationType: 'payment',
      operationKey: `payment.${attempt.id}`,
      currency: tip.currency,
      tipId: tip.id,
      traceId,
      lines: buildCollectPaymentPosting(posting),
    });
    await scheduleCollectTransfer(tx, {
      tipId: tip.id,
      profileId: tip.profileId,
      amountMinor: quote.recipientNetMinor - (share?.amountMinor ?? 0n),
      currency: tip.currency,
      provider,
      chargeReference: event.chargeReference ?? null,
      settledAt: now,
      environment: collectEnvironment(event),
    });
    if (share)
      await scheduleCollectSweep(tx, {
        tipId: tip.id,
        profileId: tip.profileId,
        businessId: share.businessId,
        amountMinor: share.amountMinor,
        currency: tip.currency,
        provider,
      });
  } else {
    await postLedgerTransaction(tx, {
      operationType: 'payment',
      operationKey: `payment.${attempt.id}`,
      currency: tip.currency,
      tipId: tip.id,
      traceId,
      lines: buildPaymentPosting(posting),
    });
    // Option B (owner, 11 Nov 2026): the share's money is on the staff member's own account. It is
    // moved to the business once it is available there, staff -> TipMe -> business (the worker).
    if (share)
      await scheduleShareSweep(tx, {
        tipId: tip.id,
        profileId: tip.profileId,
        businessId: share.businessId,
        amountMinor: share.amountMinor,
        currency: tip.currency,
        provider,
      });
  }
  await enqueueOutbox(tx, {
    eventType: 'tip.succeeded',
    aggregateId: tip.id,
    payload: {
      tipId: tip.id,
      profileId: tip.profileId,
      currency: tip.currency,
      grossMinor: formatMinor(quote.tipMinor),
      recipientNetMinor: formatMinor(quote.recipientNetMinor),
    },
  });
  return 'applied';
}

/** The environment a collect tip was paid in: required from Bachs, `sandbox` for the pretend one. */
function collectEnvironment(event: PaymentEvent): 'sandbox' | 'live' {
  if (event.environment) return event.environment;
  if (recordedProviderName(event.provider) === 'bachs')
    throw new Error(
      'a collect tip on Bachs needs the environment it was paid in',
    );
  return 'sandbox';
}

/** JSON-safe copy of a provider payload: bigint becomes a decimal string, undefined is dropped. */
export function jsonSafe(value: unknown): unknown {
  // A missing payload is stored as {}: a JSON null would reach the NOT NULL column as SQL NULL.
  if (value === undefined || value === null) return {};
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as unknown;
}
