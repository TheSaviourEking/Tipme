import { createHash } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { TipPurpose } from '@tipme/contracts';
import type { Database, Tx } from '../client.js';
import {
  moments,
  paymentAttempts,
  paymentIntents,
  profiles,
  tipMessages,
  tipQuotes,
  tips,
} from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { recordTransition } from './transitions.js';

/** Only a moment this recipient actually shared can label a tip; anything else is ignored. */
async function sharedMomentOf(
  tx: Tx,
  profileId: string,
  momentId: string | undefined,
): Promise<string | null> {
  if (!momentId || !/^[0-9a-f-]{36}$/.test(momentId)) return null;
  const [moment] = await tx
    .select({ id: moments.id })
    .from(moments)
    .where(
      and(
        eq(moments.id, momentId),
        eq(moments.profileId, profileId),
        isNotNull(moments.sharedAt),
      ),
    );
  return moment?.id ?? null;
}

export interface CreatePaymentIntentInput {
  quoteId: string;
  idempotencyKey: string;
  payerDisplayLabel?: string;
  /** One of the contract's tip purposes; the API validates it before it gets here. */
  purpose?: TipPurpose;
  /** A shared moment of this recipient the supporter is adding to ("add to the celebration"). */
  celebrationMomentId?: string;
  message?: string;
  traceId?: string | null;
  now?: Date;
  /** Test-only: throw after the named step to prove the transaction rolls back. Ignored unless NODE_ENV=test. */
  __testFailAfter?: 'tip';
}

export interface PaymentIntentResult {
  intentId: string;
  tipId: string;
  attemptId: string;
  replayed: boolean;
}

// Control characters removed, whitespace collapsed; at most 60 characters.
const cleanLabel = (label: string | undefined): string | null => {
  if (label === undefined) return null;
  const cleaned = label
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned === '' ? null : cleaned;
};

/**
 * Creates the intent, its tip (AWAITING_PAYMENT), the optional message and attempt #1 in one
 * transaction. The (profile, idempotency key) uniqueness makes concurrent duplicates converge on
 * one record: a replay with the same request returns it; a different request is a conflict.
 * A quote funds exactly one tip.
 */
export async function createPaymentIntent(
  db: Database,
  input: CreatePaymentIntentInput,
): Promise<PaymentIntentResult> {
  const now = input.now ?? new Date();
  const traceId = input.traceId ?? activeTraceId();
  const label = cleanLabel(input.payerDisplayLabel);
  const message = input.message === undefined ? null : input.message.trim();
  // Validated here, not by the database CHECK: a database error would echo the text upward.
  if (message !== null && (message.length === 0 || message.length > 280))
    throw new OperationError('INVALID_INPUT');
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        input.quoteId,
        label,
        message,
        input.celebrationMomentId ?? null,
      ]),
    )
    .digest('hex');

  return guarded(() =>
    db.transaction(async (tx) => {
      const [quote] = await tx
        .select()
        .from(tipQuotes)
        .where(eq(tipQuotes.id, input.quoteId));
      if (!quote) throw new OperationError('QUOTE_NOT_FOUND');
      // The same key replays the original tip, even after the quote has expired.
      const replay = async (): Promise<PaymentIntentResult | null> => {
        const [existing] = await tx
          .select({
            id: paymentIntents.id,
            fingerprint: paymentIntents.requestFingerprint,
          })
          .from(paymentIntents)
          .where(
            and(
              eq(paymentIntents.profileId, quote.profileId),
              eq(paymentIntents.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (!existing) return null;
        if (existing.fingerprint !== fingerprint)
          throw new OperationError('IDEMPOTENCY_CONFLICT');
        const [tip] = await tx
          .select({ id: tips.id })
          .from(tips)
          .where(eq(tips.intentId, existing.id));
        const [attempt] = await tx
          .select({ id: paymentAttempts.id })
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.intentId, existing.id),
              eq(paymentAttempts.attemptNumber, 1),
            ),
          );
        if (!tip || !attempt) throw new OperationError('IDEMPOTENCY_CONFLICT');
        return {
          intentId: existing.id,
          tipId: tip.id,
          attemptId: attempt.id,
          replayed: true,
        };
      };
      const earlier = await replay();
      if (earlier) return earlier;
      if (quote.expiresAt.getTime() < now.getTime())
        throw new OperationError('QUOTE_EXPIRED');
      // A page that went not live (or was deleted) after the quote can no longer be tipped.
      const [page] = await tx
        .select({ pageState: profiles.pageState, status: profiles.status })
        .from(profiles)
        .where(eq(profiles.id, quote.profileId));
      if (page?.pageState !== 'live' || page.status !== 'active')
        throw new OperationError('TIP_NOT_PAYABLE');

      const intentId = newId();
      // No conflict target: the idempotency key and the single-use quote are both unique.
      const inserted = await tx
        .insert(paymentIntents)
        .values({
          id: intentId,
          quoteId: quote.id,
          profileId: quote.profileId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          status: 'AWAITING_PAYMENT',
          expiresAt: quote.expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: paymentIntents.id });

      if (inserted.length === 0) {
        // Either a concurrent request with this key won (replay it) or the quote is already used.
        const raced = await replay();
        if (raced) return raced;
        throw new OperationError('QUOTE_ALREADY_USED');
      }

      const tipId = newId();
      await tx.insert(tips).values({
        id: tipId,
        intentId,
        profileId: quote.profileId,
        currency: quote.currency,
        grossMinor: quote.tipMinor,
        status: 'AWAITING_PAYMENT',
        payerDisplayLabel: label,
        purpose: input.purpose ?? null,
        celebrationMomentId: await sharedMomentOf(
          tx,
          quote.profileId,
          input.celebrationMomentId,
        ),
      });
      await recordTransition(tx, {
        entityType: 'tip',
        entityId: tipId,
        fromStatus: null,
        toStatus: 'AWAITING_PAYMENT',
        cause: 'system',
        traceId,
      });
      if (input.__testFailAfter === 'tip' && process.env['NODE_ENV'] === 'test')
        throw new Error('test failure');
      if (message !== null)
        await tx.insert(tipMessages).values({ tipId, body: message });

      const attemptId = newId();
      await tx.insert(paymentAttempts).values({
        id: attemptId,
        intentId,
        attemptNumber: 1,
        status: 'CREATED',
      });
      await recordTransition(tx, {
        entityType: 'attempt',
        entityId: attemptId,
        fromStatus: null,
        toStatus: 'CREATED',
        cause: 'system',
        traceId,
      });
      return { intentId, tipId, attemptId, replayed: false };
    }),
  );
}
