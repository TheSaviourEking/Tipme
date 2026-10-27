import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { paymentAttempts, payouts } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { enqueueOutbox } from './outbox.js';
import { recordPayoutOutcome } from './payouts.js';
import { recordProviderEvent } from './provider-events.js';

/** What reconciliation needs from a provider: an authoritative, server-to-server status check. */
export interface TransactionVerifier {
  verifyTransaction(providerReference: string): Promise<{
    status: 'succeeded' | 'failed' | 'pending' | 'not_found';
    amountMinor: bigint;
    currency: string;
    feeMinor: bigint;
  }>;
}

export type ProviderResolver<T> = T | ((provider: string) => T);

function providerFor<T>(provider: ProviderResolver<T>, name: string): T {
  return typeof provider === 'function'
    ? (provider as (provider: string) => T)(name)
    : provider;
}

const UNRESOLVED_AFTER_MS = 30 * 60 * 1000;

export async function findAttemptsToReconcile(
  db: Database,
  input: { olderThan: Date; limit: number; attemptId?: string },
): Promise<
  {
    attemptId: string;
    provider: string;
    providerReference: string;
    createdAt: Date;
  }[]
> {
  const rows = await db
    .select({
      attemptId: paymentAttempts.id,
      provider: paymentAttempts.provider,
      providerReference: paymentAttempts.providerReference,
      createdAt: paymentAttempts.createdAt,
    })
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.status, ['INITIATED', 'PENDING', 'UNKNOWN']),
        input.attemptId ? eq(paymentAttempts.id, input.attemptId) : undefined,
        isNotNull(paymentAttempts.providerReference),
        lte(paymentAttempts.createdAt, input.olderThan),
      ),
    )
    // Least recently checked first, so attempts that never resolve cannot starve newer ones.
    .orderBy(
      sql`${paymentAttempts.lastReconciledAt} ASC NULLS FIRST`,
      asc(paymentAttempts.createdAt),
    )
    .limit(input.limit);
  return rows.flatMap((row) =>
    row.provider && row.providerReference
      ? [
          {
            ...row,
            provider: row.provider,
            providerReference: row.providerReference,
          },
        ]
      : [],
  );
}

/**
 * Asks the provider about payments whose outcome we have not been told, and records a definite
 * answer as verified evidence. Deterministic event IDs make repeats (and concurrent runs) no-ops.
 * It only ever asks; it never starts or retries a charge.
 */
export async function reconcileAttempts(input: {
  db: Database;
  provider: ProviderResolver<TransactionVerifier>;
  now: Date;
  minAgeMs: number;
  limit?: number;
  /** Only this attempt (an admin re-check). */
  attemptId?: string;
}): Promise<{
  checked: number;
  applied: number;
  unresolved: number;
  errors: number;
}> {
  const attempts = await findAttemptsToReconcile(input.db, {
    olderThan: new Date(input.now.getTime() - input.minAgeMs),
    limit: input.limit ?? 50,
    attemptId: input.attemptId,
  });
  let applied = 0;
  let unresolved = 0;
  let errors = 0;
  for (const attempt of attempts) {
    try {
      const answer = await providerFor(
        input.provider,
        attempt.provider,
      ).verifyTransaction(attempt.providerReference);
      if (answer.status === 'succeeded' || answer.status === 'failed') {
        const result = await recordProviderEvent(input.db, {
          provider: attempt.provider,
          providerEventId: `reconcile.${attempt.attemptId}.${answer.status}`,
          eventType:
            answer.status === 'succeeded'
              ? 'payment.succeeded'
              : 'payment.failed',
          attemptId: attempt.attemptId,
          providerReference: attempt.providerReference,
          amountMinor: answer.amountMinor,
          currency: answer.currency,
          providerFeeMinor: answer.feeMinor,
          signatureVerified: true,
          payload: { source: 'reconciliation' },
          now: input.now,
        });
        if (result.outcome === 'applied') applied += 1;
      } else if (
        answer.status === 'not_found' &&
        input.now.getTime() - attempt.createdAt.getTime() > UNRESOLVED_AFTER_MS
      ) {
        // Once per attempt (dedupe key); counted only when the alert is new.
        const raised = await input.db.transaction((tx) =>
          enqueueOutbox(tx, {
            eventType: 'payment.unresolved',
            aggregateId: attempt.attemptId,
            payload: { attemptId: attempt.attemptId },
          }),
        );
        if (raised) unresolved += 1;
      }
    } catch {
      // One failing check (provider timeout, bad answer) must not stop the rest of the batch.
      errors += 1;
    } finally {
      await input.db
        .update(paymentAttempts)
        .set({ lastReconciledAt: input.now })
        .where(eq(paymentAttempts.id, attempt.attemptId))
        .catch(() => undefined);
    }
  }
  return { checked: attempts.length, applied, unresolved, errors };
}

/** What payout reconciliation needs from a provider. */
export interface PayoutVerifier {
  fetchPayoutStatus(
    providerReference: string,
  ): Promise<{ status: 'paid' | 'failed' | 'pending' | 'not_found' }>;
}

/**
 * Asks the provider about payouts it has not confirmed to us (REQUESTED or PROCESSING with a
 * reference), least recently checked first, and records a definite answer through
 * recordPayoutOutcome with a deterministic event ID. Recovers payout webhooks that arrived early
 * (parked as unmatched) or never arrived. Never initiates a payout.
 */
export async function reconcilePayouts(input: {
  db: Database;
  provider: ProviderResolver<PayoutVerifier>;
  now: Date;
  minAgeMs: number;
  limit?: number;
  /** Only this payout (an admin re-check). */
  payoutId?: string;
}): Promise<{ checked: number; applied: number; errors: number }> {
  const candidates = await input.db
    .select({
      payoutId: payouts.id,
      provider: payouts.provider,
      providerReference: payouts.providerReference,
    })
    .from(payouts)
    .where(
      and(
        inArray(payouts.status, ['REQUESTED', 'PROCESSING']),
        input.payoutId ? eq(payouts.id, input.payoutId) : undefined,
        isNotNull(payouts.providerReference),
        lte(payouts.createdAt, new Date(input.now.getTime() - input.minAgeMs)),
      ),
    )
    .orderBy(
      sql`${payouts.lastReconciledAt} ASC NULLS FIRST`,
      asc(payouts.createdAt),
    )
    .limit(input.limit ?? 50);
  let applied = 0;
  let errors = 0;
  for (const payout of candidates) {
    if (!payout.provider || !payout.providerReference) continue;
    try {
      const answer = await providerFor(
        input.provider,
        payout.provider,
      ).fetchPayoutStatus(payout.providerReference);
      if (answer.status === 'paid' || answer.status === 'failed') {
        const result = await recordPayoutOutcome(input.db, {
          payoutId: payout.payoutId,
          provider: payout.provider,
          providerEventId: `reconcile.${payout.payoutId}.${answer.status}`,
          providerReference: payout.providerReference,
          outcome: answer.status,
          signatureVerified: true,
          payload: { source: 'reconciliation' },
          now: input.now,
        });
        if (result.outcome === 'applied') applied += 1;
      }
    } catch {
      errors += 1;
    } finally {
      await input.db
        .update(payouts)
        .set({ lastReconciledAt: input.now })
        .where(eq(payouts.id, payout.payoutId))
        .catch(() => undefined);
    }
  }
  return { checked: candidates.length, applied, errors };
}

export type RecheckOutcome =
  'applied' | 'unchanged' | 'unresolved' | 'error' | 'not_pending';

/**
 * Staff "re-check with the provider" (permission `payments.recheck`): runs reconciliation for one
 * attempt or payout. It only ever asks the provider and books what it verifiably answers; it never
 * charges, pays or refunds. Audited with the reason.
 */
export async function recheckSubject(input: {
  db: Database;
  provider: ProviderResolver<TransactionVerifier & PayoutVerifier>;
  attemptId?: string;
  payoutId?: string;
  staffUserId: string;
  reason: string;
  now?: Date;
}): Promise<{ outcome: RecheckOutcome }> {
  const now = input.now ?? new Date();
  let outcome: RecheckOutcome;
  if (input.attemptId) {
    const result = await reconcileAttempts({
      db: input.db,
      provider: input.provider,
      now,
      minAgeMs: 0,
      limit: 1,
      attemptId: input.attemptId,
    });
    outcome =
      result.checked === 0
        ? 'not_pending'
        : result.errors > 0
          ? 'error'
          : result.applied > 0
            ? 'applied'
            : result.unresolved > 0
              ? 'unresolved'
              : 'unchanged';
  } else if (input.payoutId) {
    const result = await reconcilePayouts({
      db: input.db,
      provider: input.provider,
      now,
      minAgeMs: 0,
      limit: 1,
      payoutId: input.payoutId,
    });
    outcome =
      result.checked === 0
        ? 'not_pending'
        : result.errors > 0
          ? 'error'
          : result.applied > 0
            ? 'applied'
            : 'unchanged';
  } else {
    throw new OperationError('INVALID_INPUT');
  }
  await guarded(() =>
    recordAudit(input.db, {
      staffUserId: input.staffUserId,
      action: 'payment.rechecked',
      permission: 'payments.recheck',
      subjectType: input.attemptId ? 'attempt' : 'payout',
      subjectId: input.attemptId ?? input.payoutId,
      reason: `${input.reason} [outcome: ${outcome}]`,
      now,
    }),
  );
  return { outcome };
}
