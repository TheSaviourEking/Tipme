import { createHash } from 'node:crypto';
import {
  ATTEMPT_TRANSITIONS,
  buildPaymentPosting,
  canTransition,
  formatMinor,
  TIP_TRANSITIONS,
} from '@tipme/domain';
import type { AttemptStatus, TipStatus } from '@tipme/domain';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  feeFreeCredits,
  paymentAttempts,
  paymentIntents,
  providerEvents,
  tipQuotes,
  tips,
} from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';
import { enqueueOutbox } from './outbox.js';
import { recordTransition } from './transitions.js';

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
    tip,
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
  await postLedgerTransaction(tx, {
    operationType: 'payment',
    operationKey: `payment.${attempt.id}`,
    currency: tip.currency,
    tipId: tip.id,
    traceId,
    lines: buildPaymentPosting({
      grossMinor: quote.tipMinor,
      platformFeeMinor: quote.platformFeeMinor,
      quotedProviderFeeMinor: quote.providerFeeMinor,
      actualProviderFeeMinor: providerFeeMinor,
      recipientNetMinor: quote.recipientNetMinor,
      profileId: tip.profileId,
    }),
  });
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

/** JSON-safe copy of a provider payload: bigint becomes a decimal string, undefined is dropped. */
function jsonSafe(value: unknown): unknown {
  // A missing payload is stored as {}: a JSON null would reach the NOT NULL column as SQL NULL.
  if (value === undefined || value === null) return {};
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as unknown;
}
