import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  paymentAttempts,
  paymentIntents,
  payouts,
  profiles,
  tipQuotes,
  tips,
} from '../schema.js';
import { guarded } from './errors.js';
import { activeTraceId } from './ids.js';
import { recordTransition } from './transitions.js';

/** `already`: same reference recorded before; `conflict`: a different reference (nothing changed). */
export type InitiationResult =
  'initiated' | 'already' | 'conflict' | 'not_found';

/**
 * Records that a payment was started with a provider: CREATED → INITIATED, and the provider's
 * reference, which is how later webhooks are matched to this attempt. Only the first call acts.
 */
export function markAttemptInitiated(
  db: Database,
  input: {
    attemptId: string;
    provider: string;
    providerReference: string;
    traceId?: string | null;
  },
): Promise<InitiationResult> {
  const traceId = input.traceId ?? activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [attempt] = await tx
        .select({
          status: paymentAttempts.status,
          providerReference: paymentAttempts.providerReference,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.attemptId))
        .for('update');
      if (!attempt) return 'not_found' as const;
      if (attempt.status !== 'CREATED') {
        return attempt.providerReference === input.providerReference
          ? ('already' as const)
          : ('conflict' as const);
      }
      await tx
        .update(paymentAttempts)
        .set({
          status: 'INITIATED',
          provider: input.provider,
          providerReference: input.providerReference,
        })
        .where(eq(paymentAttempts.id, input.attemptId));
      await recordTransition(tx, {
        entityType: 'attempt',
        entityId: input.attemptId,
        fromStatus: 'CREATED',
        toStatus: 'INITIATED',
        cause: 'system',
        traceId,
      });
      return 'initiated' as const;
    }),
  );
}

export function findAttemptByReference(
  db: Database,
  provider: string,
  providerReference: string,
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, provider),
          eq(paymentAttempts.providerReference, providerReference),
        ),
      );
    return row?.id ?? null;
  });
}

/** Records the provider's reference for a payout request (status is unchanged). */
export function markPayoutInitiated(
  db: Database,
  input: { payoutId: string; provider: string; providerReference: string },
): Promise<InitiationResult> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [payout] = await tx
        .select({
          status: payouts.status,
          providerReference: payouts.providerReference,
        })
        .from(payouts)
        .where(eq(payouts.id, input.payoutId))
        .for('update');
      if (!payout) return 'not_found' as const;
      if (payout.providerReference !== null) {
        return payout.providerReference === input.providerReference
          ? ('already' as const)
          : ('conflict' as const);
      }
      // A reference is recorded once, and only for a payout that has not progressed yet.
      if (payout.status !== 'REQUESTED') return 'conflict' as const;
      await tx
        .update(payouts)
        .set({
          provider: input.provider,
          providerReference: input.providerReference,
        })
        .where(eq(payouts.id, input.payoutId));
      return 'initiated' as const;
    }),
  );
}

export function findPayoutByReference(
  db: Database,
  provider: string,
  providerReference: string,
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(
          eq(payouts.provider, provider),
          eq(payouts.providerReference, providerReference),
        ),
      );
    return row?.id ?? null;
  });
}

/** The provider reference recorded when the attempt's payment started, if it has started. */
export function findAttemptReference(
  db: Database,
  attemptId: string,
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ reference: paymentAttempts.providerReference })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attemptId));
    return row?.reference ?? null;
  });
}

/** What the pretend provider's checkout page shows, found by the provider reference. */
export function findCheckoutByReference(
  db: Database,
  provider: string,
  providerReference: string,
): Promise<{
  attemptId: string;
  attemptStatus: string;
  tipId: string;
  /** What the provider charges: the quote's payer total (the amount the supporter agreed to). */
  chargeMinor: bigint;
  currency: string;
  recipientDisplayName: string;
} | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        attemptId: paymentAttempts.id,
        attemptStatus: paymentAttempts.status,
        tipId: tips.id,
        chargeMinor: tipQuotes.payerTotalMinor,
        currency: tipQuotes.currency,
        recipientDisplayName: profiles.displayName,
      })
      .from(paymentAttempts)
      .innerJoin(tips, eq(tips.intentId, paymentAttempts.intentId))
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
      .innerJoin(profiles, eq(profiles.id, tips.profileId))
      .where(
        and(
          eq(paymentAttempts.provider, provider),
          eq(paymentAttempts.providerReference, providerReference),
        ),
      );
    return row ?? null;
  });
}

/** Whether the attempt's payment has started (its reference) and where the attempt stands. */
export function findAttemptStart(
  db: Database,
  attemptId: string,
): Promise<{ status: string; reference: string | null } | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        status: paymentAttempts.status,
        reference: paymentAttempts.providerReference,
      })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attemptId));
    return row ?? null;
  });
}
