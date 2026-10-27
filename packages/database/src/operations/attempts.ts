import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  paymentAttempts,
  paymentIntents,
  paymentAccounts,
  payouts,
  issues,
  profiles,
  tipQuotes,
  tips,
} from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId } from './ids.js';
import { enqueueOutbox } from './outbox.js';
import { recordTransition } from './transitions.js';
import { recordAudit } from './audit.js';

/** `already`: same reference recorded before; `conflict`: a different reference (nothing changed). */
export type InitiationResult =
  'initiated' | 'already' | 'conflict' | 'not_found';

export type AttemptStartClaim =
  | { outcome: 'claimed'; status: 'STARTING'; provider: string }
  | {
      outcome: 'existing';
      status: string;
      provider: string | null;
      reference: string | null;
    }
  | { outcome: 'not_found' };

/**
 * Claims an attempt before a provider create call. The row lock makes concurrent/replayed requests
 * converge on one winner; STARTING is never claimable a second time.
 */
export function claimAttemptStart(
  db: Database,
  input: {
    attemptId: string;
    provider: string;
    now?: Date;
    traceId?: string | null;
  },
): Promise<AttemptStartClaim> {
  const now = input.now ?? new Date();
  const traceId = input.traceId ?? activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [attempt] = await tx
        .select({
          status: paymentAttempts.status,
          provider: paymentAttempts.provider,
          reference: paymentAttempts.providerReference,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.attemptId))
        .for('update');
      if (!attempt) return { outcome: 'not_found' as const };
      if (attempt.status !== 'CREATED') {
        return {
          outcome: 'existing' as const,
          status: attempt.status,
          provider: attempt.provider,
          reference: attempt.reference,
        };
      }

      await tx
        .update(paymentAttempts)
        .set({
          status: 'STARTING',
          provider: input.provider,
          startClaimedAt: now,
        })
        .where(eq(paymentAttempts.id, input.attemptId));
      await recordTransition(tx, {
        entityType: 'attempt',
        entityId: input.attemptId,
        fromStatus: 'CREATED',
        toStatus: 'STARTING',
        cause: 'system',
        traceId,
      });
      return {
        outcome: 'claimed' as const,
        status: 'STARTING' as const,
        provider: input.provider,
      };
    }),
  );
}

/**
 * Records that a payment was started with a provider: CREATED → INITIATED, and the provider's
 * reference, which is how later webhooks are matched to this attempt. Mock remains compatible with
 * the original CREATED → INITIATED path; external providers should claim STARTING first.
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
          provider: paymentAttempts.provider,
          providerReference: paymentAttempts.providerReference,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.attemptId))
        .for('update');
      if (!attempt) return 'not_found' as const;
      if (attempt.status !== 'CREATED' && attempt.status !== 'STARTING') {
        return attempt.providerReference === input.providerReference
          ? ('already' as const)
          : ('conflict' as const);
      }
      if (attempt.status === 'STARTING' && attempt.provider !== input.provider)
        return 'conflict' as const;
      const fromStatus = attempt.status;
      await tx
        .update(paymentAttempts)
        .set({
          status: 'INITIATED',
          provider: input.provider,
          providerReference: input.providerReference,
          startClaimedAt: null,
        })
        .where(eq(paymentAttempts.id, input.attemptId));
      await recordTransition(tx, {
        entityType: 'attempt',
        entityId: input.attemptId,
        fromStatus,
        toStatus: 'INITIATED',
        cause: 'system',
        traceId,
      });
      return 'initiated' as const;
    }),
  );
}

/** Makes an ambiguous provider create durable and non-retryable without inventing a reference. */
export function markAttemptUnknown(
  db: Database,
  input: {
    attemptId: string;
    provider: string;
    now?: Date;
    traceId?: string | null;
  },
): Promise<'unknown' | 'already_unknown' | 'conflict' | 'not_found'> {
  const now = input.now ?? new Date();
  const traceId = input.traceId ?? activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [attempt] = await tx
        .select({
          status: paymentAttempts.status,
          provider: paymentAttempts.provider,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.attemptId))
        .for('update');
      if (!attempt) return 'not_found' as const;
      if (attempt.status === 'UNKNOWN' && attempt.provider === input.provider)
        return 'already_unknown' as const;
      if (
        attempt.status !== 'STARTING' ||
        attempt.provider !== input.provider
      ) {
        return 'conflict' as const;
      }
      await tx
        .update(paymentAttempts)
        .set({
          status: 'UNKNOWN',
          startClaimedAt: null,
          lastReconciledAt: now,
        })
        .where(eq(paymentAttempts.id, input.attemptId));
      await recordTransition(tx, {
        entityType: 'attempt',
        entityId: input.attemptId,
        fromStatus: 'STARTING',
        toStatus: 'UNKNOWN',
        cause: 'system',
        traceId,
      });
      await enqueueOutbox(tx, {
        eventType: 'payment.unresolved',
        aggregateId: input.attemptId,
        payload: { attemptId: input.attemptId },
      });
      return 'unknown' as const;
    }),
  );
}

/**
 * The provider definitely refused to start this payment (for example a 4xx with no checkout):
 * the claimed attempt fails and its tip fails with it, so the supporter can start a new tip.
 * Only a STARTING claim by the same provider moves; nothing external is retried.
 */
export function markAttemptStartFailed(
  db: Database,
  input: {
    attemptId: string;
    provider: string;
    traceId?: string | null;
  },
): Promise<'failed' | 'already_failed' | 'conflict' | 'not_found'> {
  const traceId = input.traceId ?? activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      // Attempt before tip: the same lock order as provider events and expiry.
      const [attempt] = await tx
        .select({
          status: paymentAttempts.status,
          provider: paymentAttempts.provider,
          intentId: paymentAttempts.intentId,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, input.attemptId))
        .for('update');
      if (!attempt) return 'not_found' as const;
      if (attempt.provider !== input.provider) return 'conflict' as const;
      if (attempt.status === 'VERIFIED_FAILED')
        return 'already_failed' as const;
      if (attempt.status !== 'STARTING') return 'conflict' as const;
      const [tip] = await tx
        .select({ id: tips.id, status: tips.status })
        .from(tips)
        .where(eq(tips.intentId, attempt.intentId))
        .for('update');
      await tx
        .update(paymentAttempts)
        .set({ status: 'VERIFIED_FAILED', startClaimedAt: null })
        .where(eq(paymentAttempts.id, input.attemptId));
      await recordTransition(tx, {
        entityType: 'attempt',
        entityId: input.attemptId,
        fromStatus: 'STARTING',
        toStatus: 'VERIFIED_FAILED',
        cause: 'system',
        traceId,
      });
      if (tip && tip.status === 'AWAITING_PAYMENT') {
        await tx
          .update(tips)
          .set({ status: 'FAILED' })
          .where(eq(tips.id, tip.id));
        await recordTransition(tx, {
          entityType: 'tip',
          entityId: tip.id,
          fromStatus: tip.status,
          toStatus: 'FAILED',
          cause: 'system',
          traceId,
        });
      }
      return 'failed' as const;
    }),
  );
}

/**
 * Converts abandoned STARTING claims to UNKNOWN and opens the normal payment-unresolved issue.
 * This only records the unresolved state; it never replays the external create operation.
 */
export function expireStaleAttemptStarts(
  db: Database,
  input: { olderThan: Date; now: Date; limit?: number },
): Promise<number> {
  const traceId = activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      const stale = await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.status, 'STARTING'),
            lte(paymentAttempts.startClaimedAt, input.olderThan),
          ),
        )
        .orderBy(paymentAttempts.startClaimedAt)
        .limit(input.limit ?? 100)
        .for('update');
      for (const attempt of stale) {
        await tx
          .update(paymentAttempts)
          .set({ status: 'UNKNOWN', startClaimedAt: null })
          .where(eq(paymentAttempts.id, attempt.id));
        await recordTransition(tx, {
          entityType: 'attempt',
          entityId: attempt.id,
          fromStatus: 'STARTING',
          toStatus: 'UNKNOWN',
          cause: 'system',
          traceId,
        });
        await enqueueOutbox(tx, {
          eventType: 'payment.unresolved',
          aggregateId: attempt.id,
          payload: { attemptId: attempt.id },
        });
      }
      return stale.length;
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

/**
 * Finds a Bachs attempt from its signed webhook operation reference only when the connected
 * account matches the recipient's persisted sandbox account mapping.
 */
export function findBachsAttemptByOperationReference(
  db: Database,
  input: { attemptId: string; accountReference: string },
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(
        paymentAccounts,
        and(
          eq(paymentAccounts.profileId, paymentIntents.profileId),
          eq(paymentAccounts.provider, 'bachs'),
          eq(paymentAccounts.environment, 'sandbox'),
          eq(paymentAccounts.providerAccountReference, input.accountReference),
        ),
      )
      .where(
        and(
          eq(paymentAttempts.id, input.attemptId),
          eq(paymentAttempts.provider, 'bachs'),
        ),
      );
    return row?.id ?? null;
  });
}

/** Matches an already-known Bachs checkout only through its persisted account mapping. */
/** Private operator lookup for an unknown Bachs attempt with no persisted checkout reference. */
export function getUnknownBachsAttemptForOperations(
  db: Database,
  attemptId: string,
): Promise<{
  attemptId: string;
  profileId: string;
  amountMinor: bigint;
  currency: string;
  accountReference: string;
} | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        attemptId: paymentAttempts.id,
        profileId: paymentIntents.profileId,
        amountMinor: tipQuotes.payerTotalMinor,
        currency: tipQuotes.currency,
        accountReference: paymentAccounts.providerAccountReference,
      })
      .from(paymentAttempts)
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
      .innerJoin(
        paymentAccounts,
        and(
          eq(paymentAccounts.profileId, paymentIntents.profileId),
          eq(paymentAccounts.provider, 'bachs'),
          eq(paymentAccounts.environment, 'sandbox'),
          eq(paymentAccounts.feeCollector, 'platform'),
          isNotNull(paymentAccounts.providerAccountReference),
        ),
      )
      .where(
        and(
          eq(paymentAttempts.id, attemptId),
          eq(paymentAttempts.provider, 'bachs'),
          eq(paymentAttempts.status, 'UNKNOWN'),
          isNull(paymentAttempts.providerReference),
        ),
      );
    if (!row?.accountReference) return null;
    return { ...row, accountReference: row.accountReference };
  });
}

/** Persists a server-verified dashboard checkout reference without resolving its outcome. */
export function attachUnknownBachsCheckoutForOperations(
  db: Database,
  input: {
    issueId: string;
    attemptId: string;
    providerReference: string;
    accountReference: string;
    amountMinor: bigint;
    currency: string;
    staffUserId: string;
    reason: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  if (
    !/^acct_[A-Za-z0-9]{1,60}:chk_[A-Za-z0-9]{1,60}$/.test(
      input.providerReference,
    ) ||
    !input.providerReference.startsWith(`${input.accountReference}:`) ||
    !/^acct_[A-Za-z0-9]{1,60}$/.test(input.accountReference) ||
    input.amountMinor <= 0n ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    input.reason.trim().length < 10
  ) {
    return Promise.reject(new OperationError('INVALID_INPUT'));
  }
  return guarded(() =>
    db.transaction(async (tx) => {
      const [issue] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.kind, 'payment_attempt_unresolved'),
            eq(issues.status, 'open'),
            sql`${issues.subject}->>'attemptId' = ${input.attemptId}`,
          ),
        )
        .for('update');
      if (!issue) return false;

      const [row] = await tx
        .select({
          status: paymentAttempts.status,
          provider: paymentAttempts.provider,
          providerReference: paymentAttempts.providerReference,
          expectedAmount: tipQuotes.payerTotalMinor,
          currency: tipQuotes.currency,
          accountReference: paymentAccounts.providerAccountReference,
        })
        .from(paymentAttempts)
        .innerJoin(
          paymentIntents,
          eq(paymentIntents.id, paymentAttempts.intentId),
        )
        .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
        .innerJoin(
          paymentAccounts,
          and(
            eq(paymentAccounts.profileId, paymentIntents.profileId),
            eq(paymentAccounts.provider, 'bachs'),
            eq(paymentAccounts.environment, 'sandbox'),
            eq(paymentAccounts.feeCollector, 'platform'),
            eq(
              paymentAccounts.providerAccountReference,
              input.accountReference,
            ),
          ),
        )
        .where(eq(paymentAttempts.id, input.attemptId))
        .for('update');
      if (
        !row ||
        row.status !== 'UNKNOWN' ||
        row.provider !== 'bachs' ||
        row.providerReference !== null ||
        row.accountReference !== input.accountReference ||
        row.expectedAmount !== input.amountMinor ||
        row.currency !== input.currency
      ) {
        return false;
      }

      const [updated] = await tx
        .update(paymentAttempts)
        .set({ providerReference: input.providerReference })
        .where(
          and(
            eq(paymentAttempts.id, input.attemptId),
            eq(paymentAttempts.status, 'UNKNOWN'),
            isNull(paymentAttempts.providerReference),
          ),
        )
        .returning({ id: paymentAttempts.id });
      if (!updated) return false;
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'payment_attempt.checkout_recovered',
        permission: 'payments.recheck',
        subjectType: 'payment_attempt',
        subjectId: input.attemptId,
        reason: `${input.reason} [checkout found in Bachs Dashboard; provider amount and currency matched]`,
        now,
      });
      return true;
    }),
  );
}

export function findBachsAttemptByReference(
  db: Database,
  input: { providerReference: string; accountReference: string },
): Promise<string | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(
        paymentAccounts,
        and(
          eq(paymentAccounts.profileId, paymentIntents.profileId),
          eq(paymentAccounts.provider, 'bachs'),
          eq(paymentAccounts.environment, 'sandbox'),
          eq(paymentAccounts.providerAccountReference, input.accountReference),
        ),
      )
      .where(
        and(
          eq(paymentAttempts.provider, 'bachs'),
          eq(paymentAttempts.providerReference, input.providerReference),
        ),
      );
    return row?.id ?? null;
  });
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
): Promise<{
  status: string;
  provider: string | null;
  reference: string | null;
} | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        status: paymentAttempts.status,
        provider: paymentAttempts.provider,
        reference: paymentAttempts.providerReference,
      })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attemptId));
    return row ?? null;
  });
}
