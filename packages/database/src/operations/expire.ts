import { canTransition, TIP_TRANSITIONS } from '@tipme/domain';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { paymentAttempts, paymentIntents, tipQuotes, tips } from '../schema.js';
import { markAttemptInitiated } from './attempts.js';
import { guarded } from './errors.js';
import { activeTraceId } from './ids.js';
import { recordProviderEvent } from './provider-events.js';
import type { TransactionVerifier } from './reconcile.js';
import { recordTransition } from './transitions.js';

const EXPIRABLE = ['CREATED', 'INITIATED'] as const;

/** Reconciliation's verifier, plus a lookup by TipMe's own attempt id (the merchant reference). */
export interface PaymentLookup extends TransactionVerifier {
  name: string;
  findPayment(attemptId: string): Promise<{ providerReference: string } | null>;
}

/**
 * Cancels tips that were never paid: attempts still CREATED/INITIATED whose quote expired more
 * than `graceMs` ago. The provider is always asked first, so a tip that was in fact paid is
 * recorded as paid (verified evidence), never cancelled. An attempt with no provider reference
 * (its start timed out or failed) is looked up by its own id: the provider may have started it.
 */
export async function expireStaleTips(input: {
  db: Database;
  provider: PaymentLookup | ((provider: string | null) => PaymentLookup);
  now: Date;
  graceMs?: number;
  limit?: number;
}): Promise<{ expired: number; paid: number; errors: number }> {
  const { db, now } = input;
  const cutoff = new Date(now.getTime() - (input.graceMs ?? 15 * 60_000));
  const candidates = await guarded(() =>
    db
      .select({
        attemptId: paymentAttempts.id,
        provider: paymentAttempts.provider,
        providerReference: paymentAttempts.providerReference,
      })
      .from(paymentAttempts)
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
      .where(
        and(
          inArray(paymentAttempts.status, [...EXPIRABLE]),
          lt(tipQuotes.expiresAt, cutoff),
        ),
      )
      // Least recently checked first, so checks that keep failing cannot starve newer tips.
      .orderBy(
        sql`${paymentAttempts.lastReconciledAt} ASC NULLS FIRST`,
        asc(paymentAttempts.createdAt),
      )
      .limit(input.limit ?? 50),
  );
  let expired = 0;
  let paid = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      const provider =
        typeof input.provider === 'function'
          ? input.provider(candidate.provider)
          : input.provider;
      if (!candidate.providerReference) {
        const found = await provider.findPayment(candidate.attemptId);
        if (found) {
          // Record the reference first, so a webhook for it can be matched from now on.
          const recorded = await markAttemptInitiated(db, {
            attemptId: candidate.attemptId,
            provider: provider.name,
            providerReference: found.providerReference,
          });
          // Something else moved the attempt meanwhile; leave it to the next run.
          if (recorded === 'conflict' || recorded === 'not_found') continue;
          candidate.provider = provider.name;
          candidate.providerReference = found.providerReference;
        }
      }
      if (candidate.provider && candidate.providerReference) {
        const answer = await provider.verifyTransaction(
          candidate.providerReference,
        );
        if (answer.status === 'succeeded' || answer.status === 'failed') {
          // Same deterministic ID as reconciliation, so the two can never both apply it.
          const result = await recordProviderEvent(db, {
            provider: candidate.provider,
            providerEventId: `reconcile.${candidate.attemptId}.${answer.status}`,
            eventType:
              answer.status === 'succeeded'
                ? 'payment.succeeded'
                : 'payment.failed',
            attemptId: candidate.attemptId,
            providerReference: candidate.providerReference,
            amountMinor: answer.amountMinor,
            currency: answer.currency,
            providerFeeMinor: answer.feeMinor,
            signatureVerified: true,
            payload: { source: 'expiry' },
            now,
          });
          if (answer.status === 'succeeded' && result.outcome === 'applied')
            paid += 1;
          continue;
        }
      }
      if (await expire(db, candidate.attemptId)) expired += 1;
    } catch {
      // One failing check must not stop the batch; the tip stays as it was.
      errors += 1;
    } finally {
      await db
        .update(paymentAttempts)
        .set({ lastReconciledAt: now })
        .where(eq(paymentAttempts.id, candidate.attemptId))
        .catch(() => undefined);
    }
  }
  return { expired, paid, errors };
}

/** Attempt → EXPIRED and tip → CANCELLED together, only if nothing moved them meanwhile. */
function expire(db: Database, attemptId: string): Promise<boolean> {
  const traceId = activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      // Attempt before tip: the same lock order as provider events.
      const [attempt] = await tx
        .select({
          status: paymentAttempts.status,
          intentId: paymentAttempts.intentId,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, attemptId))
        .for('update');
      if (
        !attempt ||
        !(EXPIRABLE as readonly string[]).includes(attempt.status)
      )
        return false;
      const [tip] = await tx
        .select({ id: tips.id, status: tips.status })
        .from(tips)
        .where(eq(tips.intentId, attempt.intentId))
        .for('update');
      if (!tip || !canTransition(TIP_TRANSITIONS, tip.status, 'CANCELLED'))
        return false;
      await tx
        .update(paymentAttempts)
        .set({ status: 'EXPIRED' })
        .where(eq(paymentAttempts.id, attemptId));
      await recordTransition(tx, {
        entityType: 'attempt',
        entityId: attemptId,
        fromStatus: attempt.status,
        toStatus: 'EXPIRED',
        cause: 'expiry',
        traceId,
      });
      await tx
        .update(tips)
        .set({ status: 'CANCELLED' })
        .where(eq(tips.id, tip.id));
      await recordTransition(tx, {
        entityType: 'tip',
        entityId: tip.id,
        fromStatus: tip.status,
        toStatus: 'CANCELLED',
        cause: 'expiry',
        traceId,
      });
      return true;
    }),
  );
}
