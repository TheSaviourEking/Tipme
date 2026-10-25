import { createHash } from 'node:crypto';
import {
  FEE_POLICY_V1,
  buildPayoutPosting,
  canTransition,
  formatMinor,
  PAYOUT_TRANSITIONS,
} from '@tipme/domain';
import type { PayoutStatus } from '@tipme/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  paymentIntents,
  payoutItems,
  payouts,
  profiles,
  providerEvents,
  tipQuotes,
  tips,
} from '../schema.js';
import { markPayoutInitiated } from './attempts.js';
import { balanceIn } from './balance.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';
import { enqueueOutbox } from './outbox.js';
import { recordTransition } from './transitions.js';

export interface PayoutResult {
  payoutId: string;
  amountMinor: bigint;
  currency: string;
  replayed: boolean;
}

/**
 * Requests a payout of the recipient's net for succeeded tips. Each tip can be in only one active
 * payout (partial unique index); the idempotency key makes retries return the original payout.
 */
export async function createPayout(
  db: Database,
  input: {
    profileId: string;
    tipIds: string[];
    idempotencyKey: string;
    traceId?: string | null;
  },
): Promise<PayoutResult> {
  const traceId = input.traceId ?? activeTraceId();
  const ids = [...new Set(input.tipIds)].sort();
  // A reused key must describe the same request (same recipient, same tips) to replay.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.profileId, ids]))
    .digest('hex');
  return guarded(() =>
    db.transaction(async (tx) => {
      const replay = async (): Promise<PayoutResult | null> => {
        const [existing] = await tx
          .select()
          .from(payouts)
          .where(eq(payouts.idempotencyKey, input.idempotencyKey));
        if (!existing) return null;
        if (existing.requestFingerprint !== fingerprint)
          throw new OperationError('IDEMPOTENCY_CONFLICT');
        return {
          payoutId: existing.id,
          amountMinor: existing.amountMinor,
          currency: existing.currency,
          replayed: true,
        };
      };
      const earlier = await replay();
      if (earlier) return earlier;

      if (ids.length === 0) throw new OperationError('TIP_NOT_PAYABLE');
      const rows = await tx
        .select({
          id: tips.id,
          profileId: tips.profileId,
          status: tips.status,
          currency: tips.currency,
          net: tipQuotes.recipientNetMinor,
        })
        .from(tips)
        .innerJoin(paymentIntents, eq(paymentIntents.id, tips.intentId))
        .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
        .where(inArray(tips.id, ids))
        .for('update', { of: tips });
      // The same request may have committed while this one waited for the tips' locks.
      const afterLock = await replay();
      if (afterLock) return afterLock;
      const claimed = await tx
        .select({ tipId: payoutItems.tipId })
        .from(payoutItems)
        .where(
          and(inArray(payoutItems.tipId, ids), eq(payoutItems.active, true)),
        );
      if (
        rows.length !== ids.length ||
        claimed.length > 0 ||
        rows.some(
          (row) =>
            row.profileId !== input.profileId || row.status !== 'SUCCEEDED',
        )
      ) {
        throw new OperationError('TIP_NOT_PAYABLE');
      }
      const currencies = new Set(rows.map((row) => row.currency));
      const [currency] = currencies;
      if (currencies.size !== 1 || !currency)
        throw new OperationError('CURRENCY_MISMATCH');
      const amountMinor = rows.reduce((sum, row) => sum + row.net, 0n);

      const payoutId = newId();
      const inserted = await tx
        .insert(payouts)
        .values({
          id: payoutId,
          profileId: input.profileId,
          currency,
          amountMinor,
          status: 'REQUESTED',
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
        })
        .onConflictDoNothing({ target: payouts.idempotencyKey })
        .returning({ id: payouts.id });
      if (inserted.length === 0) {
        const raced = await replay();
        if (raced) return raced;
        throw new OperationError('IDEMPOTENCY_CONFLICT');
      }
      await tx
        .insert(payoutItems)
        .values(ids.map((tipId) => ({ payoutId, tipId })));
      await recordTransition(tx, {
        entityType: 'payout',
        entityId: payoutId,
        fromStatus: null,
        toStatus: 'REQUESTED',
        cause: 'system',
        traceId,
      });
      return { payoutId, amountMinor, currency, replayed: false };
    }),
  );
}

const STATUS: Record<'processing' | 'paid' | 'failed', PayoutStatus> = {
  processing: 'PROCESSING',
  paid: 'PAID',
  failed: 'FAILED',
};

/** Applies a verified provider message about a payout; `paid` settles the payable in the ledger. */
export async function recordPayoutOutcome(
  db: Database,
  input: {
    payoutId: string;
    provider: string;
    providerEventId: string;
    providerReference: string;
    outcome: 'processing' | 'paid' | 'failed';
    signatureVerified: true;
    payload: unknown;
    traceId?: string | null;
    now?: Date;
  },
): Promise<{
  outcome: 'applied' | 'duplicate' | 'ignored' | 'conflict';
  payoutStatus: string;
}> {
  const traceId = input.traceId ?? activeTraceId();
  return guarded(() =>
    db.transaction(async (tx) => {
      const [payout] = await tx
        .select()
        .from(payouts)
        .where(eq(payouts.id, input.payoutId))
        .for('update');
      if (!payout) throw new OperationError('PAYOUT_NOT_FOUND');
      const eventRowId = newId();
      const stored = await tx
        .insert(providerEvents)
        .values({
          id: eventRowId,
          provider: input.provider,
          providerEventId: input.providerEventId,
          eventType: `payout.${input.outcome}`,
          signatureVerified: input.signatureVerified,
          payloadHash: createHash('sha256')
            .update(JSON.stringify(input.payload))
            .digest('hex'),
          payload: input.payload,
          payoutId: payout.id,
        })
        .onConflictDoNothing({
          target: [providerEvents.provider, providerEvents.providerEventId],
        })
        .returning({ id: providerEvents.id });
      if (stored.length === 0)
        return { outcome: 'duplicate' as const, payoutStatus: payout.status };

      const to = STATUS[input.outcome];
      const finish = async (
        outcome: 'applied' | 'ignored' | 'conflict',
        status: string,
      ) => {
        await tx
          .update(providerEvents)
          .set({
            processedAt: input.now ?? new Date(),
            processingOutcome: outcome,
          })
          .where(eq(providerEvents.id, eventRowId));
        return { outcome, payoutStatus: status };
      };
      if (!canTransition(PAYOUT_TRANSITIONS, payout.status, to)) {
        if (to === 'PAID' && payout.status === 'FAILED') {
          // The provider says it paid after we recorded a failure (and released the tips):
          // money may really have reached the recipient. Flag it for operations.
          await enqueueOutbox(tx, {
            eventType: 'payout.conflict',
            aggregateId: payout.id,
            dedupeSuffix: eventRowId,
            payload: { payoutId: payout.id, profileId: payout.profileId },
          });
          return finish('conflict', payout.status);
        }
        return finish('ignored', payout.status);
      }

      const now = input.now ?? new Date();
      await tx
        .update(payouts)
        .set({
          status: to,
          provider: input.provider,
          providerReference: input.providerReference,
          ...(to === 'PAID' ? { paidAt: now } : {}),
        })
        .where(eq(payouts.id, payout.id));
      await recordTransition(tx, {
        entityType: 'payout',
        entityId: payout.id,
        fromStatus: payout.status,
        toStatus: to,
        cause: 'provider_event',
        providerEventId: eventRowId,
        traceId,
      });
      if (to === 'PAID') {
        await postLedgerTransaction(tx, {
          operationType: 'payout',
          operationKey: `payout.${payout.id}`,
          currency: payout.currency,
          payoutId: payout.id,
          traceId,
          lines: buildPayoutPosting({
            amountMinor: payout.amountMinor,
            profileId: payout.profileId,
          }),
        });
        await enqueueOutbox(tx, {
          eventType: 'payout.paid',
          aggregateId: payout.id,
          payload: {
            payoutId: payout.id,
            profileId: payout.profileId,
            currency: payout.currency,
            amountMinor: formatMinor(payout.amountMinor),
          },
        });
      }
      if (to === 'FAILED') {
        // Release the tips so they can be paid out again.
        await tx
          .update(payoutItems)
          .set({ active: false })
          .where(eq(payoutItems.payoutId, payout.id));
        await enqueueOutbox(tx, {
          eventType: 'payout.failed',
          aggregateId: payout.id,
          payload: { payoutId: payout.id, profileId: payout.profileId },
        });
      }
      return finish('applied', to);
    }),
  );
}

/** What a withdrawal needs from a provider: starting the payout. */
export interface PayoutInitiator {
  name: string;
  initiatePayout(input: {
    payoutId: string;
    /** Stable across retries; providers must deduplicate payout creation by this key. */
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    scenario?: 'payout-paid' | 'payout-failed';
  }): Promise<{ providerReference: string }>;
}

/**
 * A recipient withdraws any amount up to their available balance (PR-008). The profile row is
 * locked so two withdrawals at once can never overdraw. Nothing is posted to the ledger until the
 * provider confirms the payout as paid; until then the amount is reserved, and a failed payout
 * simply releases it.
 */
export async function requestWithdrawal(
  db: Database,
  input: {
    profileId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    provider: PayoutInitiator;
    scenario?: 'payout-paid' | 'payout-failed';
    traceId?: string | null;
  },
): Promise<{
  payoutId: string;
  status: string;
  replayed: boolean;
  providerReference: string | null;
}> {
  const traceId = input.traceId ?? activeTraceId();
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        'withdrawal',
        input.profileId,
        input.amountMinor.toString(),
      ]),
    )
    .digest('hex');
  const created = await guarded(() =>
    db.transaction(async (tx) => {
      const replay = async () => {
        const [existing] = await tx
          .select()
          .from(payouts)
          .where(eq(payouts.idempotencyKey, input.idempotencyKey));
        if (!existing) return null;
        if (existing.requestFingerprint !== fingerprint)
          throw new OperationError('IDEMPOTENCY_CONFLICT');
        return existing;
      };
      const existing = await replay();
      if (existing) {
        return {
          payoutId: existing.id,
          currency: existing.currency,
          replayed: true,
        };
      }
      if (input.amountMinor <= 0n) throw new OperationError('INVALID_INPUT');
      await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .for('update');
      const afterLock = await replay();
      if (afterLock) {
        return {
          payoutId: afterLock.id,
          currency: afterLock.currency,
          replayed: true,
        };
      }
      const { availableMinor } = await balanceIn(tx, input.profileId);
      if (input.amountMinor > availableMinor)
        throw new OperationError('INSUFFICIENT_BALANCE');
      // ₦1,000 minimum (PR-012), except to take the whole balance: nobody is left with money
      // they cannot withdraw, or an account they cannot close.
      if (
        input.amountMinor < FEE_POLICY_V1.minWithdrawalMinor &&
        input.amountMinor !== availableMinor
      )
        throw new OperationError('WITHDRAWAL_TOO_SMALL');
      const payoutId = newId();
      const inserted = await tx
        .insert(payouts)
        .values({
          id: payoutId,
          profileId: input.profileId,
          currency: 'NGN',
          amountMinor: input.amountMinor,
          status: 'REQUESTED',
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
        })
        .onConflictDoNothing({ target: payouts.idempotencyKey })
        .returning({ id: payouts.id });
      if (inserted.length === 0) {
        const raced = await replay();
        if (raced) {
          return {
            payoutId: raced.id,
            currency: raced.currency,
            replayed: true,
          };
        }
        throw new OperationError('IDEMPOTENCY_CONFLICT');
      }
      await recordTransition(tx, {
        entityType: 'payout',
        entityId: payoutId,
        fromStatus: null,
        toStatus: 'REQUESTED',
        cause: 'system',
        traceId,
      });
      return { payoutId, currency: 'NGN', replayed: false };
    }),
  );
  // Start the payout once; a replay whose first attempt never reached the provider starts it now.
  const [current] = await guarded(() =>
    db
      .select({ status: payouts.status, reference: payouts.providerReference })
      .from(payouts)
      .where(eq(payouts.id, created.payoutId)),
  );
  let providerReference = current?.reference ?? null;
  if (current && !current.reference && current.status === 'REQUESTED') {
    const started = await input.provider.initiatePayout({
      payoutId: created.payoutId,
      idempotencyKey: created.payoutId,
      amountMinor: input.amountMinor,
      currency: created.currency,
      ...(input.scenario ? { scenario: input.scenario } : {}),
    });
    const outcome = await markPayoutInitiated(db, {
      payoutId: created.payoutId,
      provider: input.provider.name,
      providerReference: started.providerReference,
    });
    // A concurrent replay may have recorded its own reference first: report the winner.
    providerReference =
      outcome === 'initiated'
        ? started.providerReference
        : ((
            await guarded(() =>
              db
                .select({ reference: payouts.providerReference })
                .from(payouts)
                .where(eq(payouts.id, created.payoutId)),
            )
          )[0]?.reference ?? null);
  }
  return {
    payoutId: created.payoutId,
    status: current?.status ?? 'REQUESTED',
    replayed: created.replayed,
    providerReference,
  };
}
