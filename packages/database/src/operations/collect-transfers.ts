import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  collectTransfers,
  paymentAttempts,
  paymentIntents,
  profiles,
  tipQuotes,
} from '../schema.js';
import { collectSettingsInForce } from './collect-settings.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

/*
 * You collect (spec §5, §8; plan Task 7). A collect tip's net is held on TipMe's own partner account
 * (`held_for_recipients`) and moved on to the recipient's account by one `share` transfer per tip.
 * This file only schedules that transfer, in the payment's own transaction; the machine that sends
 * it (claim, send, read back by `transfer_group`) is Task 8's.
 */

/** The share transfer's key, which is also its `transfer_group` at the partner. */
export const collectKey = (tipId: string) => `tipme-collect-${tipId}`;

/**
 * Called with the collect payment's posting, in its transaction: the tip's one `share` row, waiting
 * for the recipient's verified account (filled when it moves to `ready`, P8). Its `release_after` is
 * the new-recipient delay (§8): `settledAt + delay_hours` while the profile is younger than
 * `delay_for_days` at `settledAt`, otherwise `settledAt`. Once per tip (the key and the one-share
 * index), so a repeat delivery inserts nothing.
 *
 * `environment` is the partner environment the tip was paid in (TipMe's copies run one environment
 * each, but the row says which). The pretend provider's tips are `sandbox`.
 */
export async function scheduleCollectTransfer(
  tx: Tx,
  i: {
    tipId: string;
    profileId: string;
    amountMinor: bigint;
    currency: string;
    provider: string;
    chargeReference: string | null;
    settledAt: Date;
    environment: 'sandbox' | 'live';
  },
): Promise<void> {
  const { environment } = i;
  if (i.amountMinor <= 0n) return;
  const settings = await collectSettingsInForce(tx, i.settledAt);
  const [profile] = await tx
    .select({ createdAt: profiles.createdAt })
    .from(profiles)
    .where(eq(profiles.id, i.profileId));
  if (!profile) throw new Error('a collect transfer needs its recipient');
  const newUntil =
    profile.createdAt.getTime() + settings.delayForDays * 24 * 3_600_000;
  const releaseAfter =
    i.settledAt.getTime() < newUntil
      ? new Date(i.settledAt.getTime() + settings.delayHours * 3_600_000)
      : i.settledAt;
  await tx
    .insert(collectTransfers)
    .values({
      id: newId(),
      kind: 'share',
      tipId: i.tipId,
      profileId: i.profileId,
      provider: i.provider,
      environment,
      amountMinor: i.amountMinor,
      currency: i.currency,
      status: 'waiting',
      idempotencyKey: collectKey(i.tipId),
      chargeReference: i.chargeReference,
      releaseAfter,
    })
    .onConflictDoNothing();
}

const PLATFORM_CHECKOUT = /^platform:[^:]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R2: the collect payment attempt a platform-scoped (TipMe's own account) event is about, or null.
 * Matched by TipMe's own reference (the attempt id, which the collect checkout sends), then by the
 * checkout (`platform:<checkout_id>`, the attempt's provider reference), then by the partner's charge
 * stored on the tip's share transfer. Only an attempt quoted `collect` on the partner (never the
 * pretend provider) can match, so a Pro purchase's event never reaches a tip; an event that matches
 * nothing goes on to Pro billing.
 */
export function matchCollectAttempt(
  db: Database,
  i: {
    providerReference: string | null;
    operationReference: string | null;
    chargeReference: string | null;
  },
): Promise<string | null> {
  return guarded(async () => {
    const byOperation =
      i.operationReference && UUID.test(i.operationReference)
        ? i.operationReference.toLowerCase()
        : null;
    const byCheckout =
      i.providerReference && PLATFORM_CHECKOUT.test(i.providerReference)
        ? i.providerReference
        : null;
    const byCharge = i.chargeReference || null;
    if (!byOperation && !byCheckout && !byCharge) return null;
    // Which reference matched: TipMe's own first, then the checkout, then the charge.
    const rank = sql<number>`CASE
      WHEN ${paymentAttempts.id}::text = ${byOperation} THEN 1
      WHEN ${paymentAttempts.providerReference} = ${byCheckout} THEN 2
      ELSE 3 END`;
    const rows = await db
      .select({ id: paymentAttempts.id, rank })
      .from(paymentAttempts)
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
      .where(
        and(
          eq(tipQuotes.collectionMode, 'collect'),
          or(
            isNull(paymentAttempts.provider),
            eq(paymentAttempts.provider, 'bachs'),
          ),
          or(
            byOperation
              ? sql`${paymentAttempts.id}::text = ${byOperation}`
              : undefined,
            byCheckout
              ? eq(paymentAttempts.providerReference, byCheckout)
              : undefined,
            byCharge
              ? and(
                  eq(paymentAttempts.status, 'VERIFIED_SUCCEEDED'),
                  sql`EXISTS (
                    SELECT 1 FROM collect_transfers c JOIN tips t ON t.id = c.tip_id
                     WHERE t.intent_id = ${paymentAttempts.intentId} AND c.kind = 'share'
                       AND c.charge_reference = ${byCharge})`,
                )
              : undefined,
          ),
        ),
      )
      .orderBy(rank, paymentAttempts.id)
      .limit(2);
    const [first, second] = rows;
    // Two attempts for one charge would be a bug: neither is guessed.
    if (!first || (second && second.rank === first.rank)) return null;
    return first.id;
  });
}
