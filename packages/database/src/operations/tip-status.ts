import {
  shownThanks,
  type PagePlan,
  type TipStatusState,
  type TipStatusView,
} from '@tipme/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { paymentAttempts, profiles, tipMessages, tips } from '../schema.js';
import { guarded } from './errors.js';

/** After this long without an answer the supporter is told we are still checking. */
export const CHECKING_AFTER_MS = 2 * 60 * 1000;

/**
 * What a supporter's status screen may show, read only from verified server state. Never the
 * message. A tip that is not final is `waiting`, or `checking` once its attempt is UNKNOWN or two
 * minutes have passed: an unconfirmed payment is never shown as success.
 */
export function tipStatusView(
  db: Database,
  tipId: string,
  now: Date,
): Promise<TipStatusView | null> {
  return guarded(async () => {
    const [tip] = await db
      .select({
        status: tips.status,
        intentId: tips.intentId,
        grossMinor: tips.grossMinor,
        currency: tips.currency,
        completedAt: tips.completedAt,
        createdAt: tips.createdAt,
        handle: profiles.handle,
        displayName: profiles.displayName,
        plan: profiles.plan,
        thanksLine: profiles.thanksLine,
        thanksStyle: profiles.thanksStyle,
        thanksSigned: profiles.thanksSigned,
      })
      .from(tips)
      .innerJoin(profiles, eq(profiles.id, tips.profileId))
      .where(eq(tips.id, tipId));
    if (!tip) return null;
    let state: TipStatusState;
    if (tip.status === 'SUCCEEDED') state = 'paid';
    else if (tip.status === 'FAILED') state = 'declined';
    else if (tip.status === 'CANCELLED') state = 'cancelled';
    else {
      const [attempt] = await db
        .select({
          status: paymentAttempts.status,
          collectedAt: paymentAttempts.collectedAt,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.intentId, tip.intentId))
        .orderBy(desc(paymentAttempts.attemptNumber))
        .limit(1);
      // The provider took the money; only its details are pending.
      state = attempt?.collectedAt
        ? 'collected'
        : attempt?.status === 'UNKNOWN' ||
            now.getTime() - tip.createdAt.getTime() > CHECKING_AFTER_MS
          ? 'checking'
          : 'waiting';
    }
    let reference: string | null = null;
    if (state === 'paid') {
      const [paidAttempt] = await db
        .select({ providerReference: paymentAttempts.providerReference })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.intentId, tip.intentId),
            eq(paymentAttempts.status, 'VERIFIED_SUCCEEDED'),
          ),
        )
        .limit(1);
      // Staff search finds a payment by this ending (ops-search byText).
      reference = paidAttempt?.providerReference
        ? paidAttempt.providerReference.slice(-6).toUpperCase()
        : null;
    }
    // Only whether consent was given; the note's text is never read here.
    let noteMayShow = false;
    if (state === 'paid') {
      const [note] = await db
        .select({ mayShow: tipMessages.mayShow })
        .from(tipMessages)
        .where(eq(tipMessages.tipId, tipId));
      noteMayShow = note?.mayShow === true;
    }
    // The recipient's line as it is now, not as it was when the tip was made (owner's answer,
    // 5 Nov 2026): an edit, or a page leaving Pro, also changes what older receipts show.
    const thanks =
      state === 'paid'
        ? shownThanks({
            line: tip.thanksLine,
            style: tip.thanksStyle,
            signed: tip.thanksSigned,
            plan: tip.plan as PagePlan,
            displayName: tip.displayName,
          })
        : null;
    return {
      state,
      recipient: { handle: tip.handle, displayName: tip.displayName },
      amountMinor: tip.grossMinor.toString(),
      currency: tip.currency,
      completedAt: tip.completedAt?.toISOString() ?? null,
      reference,
      ...(noteMayShow ? { noteMayShow: true as const } : {}),
      ...(thanks ? { thanks } : {}),
    };
  });
}
