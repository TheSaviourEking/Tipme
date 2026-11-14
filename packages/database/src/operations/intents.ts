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
import { tippableMember } from './business-access.js';
import { fixShareOnTip, shareInForce } from './share-at-tip.js';
import { guarded, OperationError } from './errors.js';
import { activeTraceId, newId } from './ids.js';
import { recordSupporter, supporterKeyHash } from './supporters.js';
import { attributeTip } from './campaigns.js';
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
  /** The supporter agreed the recipient may show their note. Ignored when there is no message. */
  noteMayShow?: true;
  /**
   * "Let {recipient} recognise me next time": the browser's key for this recipient. Honoured only
   * with a name, on a Pro page, while `recognitionOn`; otherwise ignored, never an error.
   */
  supporterKey?: string;
  /** The API's SUPPORTER_RECOGNITION switch. Off unless passed. */
  recognitionOn?: boolean;
  /**
   * The business membership the supporter's page named (TipMe for businesses). Checked against the
   * quote's page inside the transaction and ignored when it doesn't hold: never a refusal.
   */
  businessMemberId?: string;
  /**
   * The API's BUSINESS_SHARES_ENABLED (business release 2, R2-C2). Only with it is a share fixed on
   * a tip made at a membership whose agreement is in force; off, nothing about shares is read.
   */
  sharesOn?: boolean;
  /**
   * The campaign link ending the tip page was opened from (Campaign Studio). Matched to this
   * page's running campaign inside the transaction and ignored otherwise; not in the fingerprint,
   * so a retried request replays the tip and it is counted once.
   */
  campaign?: string;
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
  // Consent only counts with a note to consent for; without one it is stored nowhere.
  const mayShow = message !== null && input.noteMayShow === true;
  // A key counts only with a name to recognise; without one it is ignored and stored nowhere.
  const keyHash = label === null ? null : supporterKeyHash(input.supporterKey);
  const requestParts = [
    input.quoteId,
    label,
    message,
    input.celebrationMomentId ?? null,
    // Appended only with consent, so every fingerprint made without it (in-flight replays
    // included) stays byte-identical, and adding consent to a replayed key is a conflict.
    ...(mayShow ? [true] : []),
    // The same trick for a supporter key: only its hash, and only when it can be recorded, so a
    // request without one hashes exactly as before and adding one to a replayed key conflicts.
    ...(keyHash ? ['s', keyHash.toString('hex')] : []),
  ];
  // The validated member is appended only when it resolved, so a request without one, or whose
  // member was ignored, hashes exactly as before the business feature.
  const fingerprintOf = (memberId: string | null) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          ...requestParts,
          ...(memberId === null ? [] : ['b', memberId]),
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
      // A team quote (business release 2, R2-D) names a location, not a person, and is paid only
      // through its own intent route: here it reads as no quote at all.
      const profileId = quote.profileId;
      if (profileId === null) throw new OperationError('QUOTE_NOT_FOUND');
      // Where the tip is made, resolved before the fingerprint, since that needs the quote's page.
      // A label, never a destination: no posting reads it.
      const member = await tippableMember(
        tx,
        profileId,
        input.businessMemberId,
        now,
      );
      const fingerprint = fingerprintOf(member?.memberId ?? null);
      // The same request when its member resolved the first time and no longer does (they left
      // or the business was suspended in between): a retry replays the tip, never refuses it.
      const firstTimeFingerprint =
        member === null && input.businessMemberId !== undefined
          ? fingerprintOf(input.businessMemberId)
          : null;
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
              eq(paymentIntents.profileId, profileId),
              eq(paymentIntents.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (!existing) return null;
        if (
          existing.fingerprint !== fingerprint &&
          existing.fingerprint !== firstTimeFingerprint
        )
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
        .select({
          pageState: profiles.pageState,
          status: profiles.status,
          plan: profiles.plan,
        })
        .from(profiles)
        .where(eq(profiles.id, profileId));
      if (page?.pageState !== 'live' || page.status !== 'active')
        throw new OperationError('TIP_NOT_PAYABLE');

      // R2-C2: the supporter must have been shown the split in force now. A quote made before an
      // agreement started, changed or ended is stale: they re-quote and see the current one.
      const share =
        input.sharesOn && member
          ? await shareInForce(tx, profileId, member.memberId)
          : null;
      if (
        input.sharesOn &&
        (share?.agreementId ?? null) !== (quote.shareAgreementId ?? null)
      )
        throw new OperationError('QUOTE_EXPIRED');

      const intentId = newId();
      // No conflict target: the idempotency key and the single-use quote are both unique.
      const inserted = await tx
        .insert(paymentIntents)
        .values({
          id: intentId,
          quoteId: quote.id,
          profileId,
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
        profileId,
        currency: quote.currency,
        grossMinor: quote.tipMinor,
        status: 'AWAITING_PAYMENT',
        payerDisplayLabel: label,
        purpose: input.purpose ?? null,
        celebrationMomentId: await sharedMomentOf(
          tx,
          profileId,
          input.celebrationMomentId,
        ),
        businessMemberId: member?.memberId ?? null,
        businessLocationId: member?.locationId ?? null,
      });
      await recordTransition(tx, {
        entityType: 'tip',
        entityId: tipId,
        fromStatus: null,
        toStatus: 'AWAITING_PAYMENT',
        cause: 'system',
        traceId,
      });
      if (share)
        await fixShareOnTip(tx, {
          tipId,
          agreementId: share.agreementId,
          businessId: share.businessId,
          businessBps: share.businessBps,
          recipientNetMinor: quote.recipientNetMinor,
        });
      if (input.campaign)
        await attributeTip(tx, { profileId, tipId, slug: input.campaign });
      // Pro only, read in this transaction: a page that left Pro records no new supporter.
      if (
        keyHash &&
        label !== null &&
        input.recognitionOn === true &&
        page.plan === 'pro'
      )
        await recordSupporter(tx, {
          profileId,
          keyHash,
          label,
          tipId,
          now,
        });
      if (input.__testFailAfter === 'tip' && process.env['NODE_ENV'] === 'test')
        throw new Error('test failure');
      if (message !== null)
        await tx.insert(tipMessages).values({ tipId, body: message, mayShow });

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
