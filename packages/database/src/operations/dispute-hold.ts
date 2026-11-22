import { DISPUTE_HOLD_EVENT } from '@tipme/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import {
  collectTransfers,
  disputes,
  notifications,
  profiles,
  tips,
} from '../schema.js';
import { balanceIn } from './balance.js';
import { newId } from './ids.js';
import { enqueueOutbox } from './outbox.js';

/*
 * A dispute's hold on a recipient's balance (R4, spec §10): the notice, and (final review I1) the
 * hand-over of a refund's reservation. Kept apart from disputes.ts so the refunds can use it
 * without importing the module that imports them.
 */

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** "₦9,500", or "₦9,500.50" with kobo: as the mail templates write naira. */
function naira(minor: bigint): string {
  const kobo = minor % 100n;
  const whole = new Intl.NumberFormat('en').format(minor / 100n);
  return `₦${whole}${kobo === 0n ? '' : `.${String(kobo).padStart(2, '0')}`}`;
}

/** The spec's words (§10), with the amount held. */
export const disputeHoldCopy = (heldMinor: bigint) =>
  `A payment to you is being questioned. We’ve held ${naira(heldMinor)} until it’s settled.`;

/** The dispute-hold notice (§10): in the app at once, and by email through the outbox. */
export async function tellDisputeHold(
  tx: Tx,
  i: {
    disputeId: string;
    tipId: string;
    profileId: string;
    heldMinor: bigint;
    now: Date;
  },
): Promise<void> {
  const [owner] = await tx
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.id, i.profileId));
  if (owner?.userId)
    await tx
      .insert(notifications)
      .values({
        id: newId(),
        userId: owner.userId,
        kind: 'dispute_hold',
        tipId: i.tipId,
        title: 'A payment is being questioned',
        body: disputeHoldCopy(i.heldMinor),
        createdAt: i.now,
      })
      .onConflictDoNothing();
  await enqueueOutbox(tx, {
    eventType: DISPUTE_HOLD_EVENT,
    aggregateId: i.disputeId,
    payload: {
      disputeId: i.disputeId,
      profileId: i.profileId,
      heldMinor: i.heldMinor.toString(),
    },
  });
}

/**
 * Final review I1. A dispute's hold on the balance is taken when it opens, from what is then
 * available (`fromMovedShare`). Money the balance was keeping apart at that moment for something
 * else is not in it, and when that something ends without the money leaving, the money comes back
 * into the balance while the dispute is unsettled. It is credited here to the dispute, up to what the
 * dispute still needs:
 *
 * - a collect refund's reservation of the tip's share (its transfer back not paid), when the refund
 *   ends (`failCollectRefund`): `coverReleasedMinor`;
 * - what a failed refund took back and a `return` paid back to their account (`bookPaid`):
 *   `coverReleasedMinor`;
 * - a withdrawal that was on its way and failed (`releaseFailedPayout`): `returningMinor`, for any of
 *   the recipient's disputed tips, oldest dispute first.
 *
 * The balance counts a tip's dispute holds net of what its refunds reserve or took back (RI4:
 * `held − covered`), so what protects the tip is `max(held, covered)`. A cover released becomes the
 * dispute's own hold (protection unchanged); money returning adds to it, never past this tip's share
 * or the disputed amount, nor past what is available now.
 *
 * Exactly once: each caller runs it in the transaction that ends the other thing (zeroes the
 * reservation, books the return paid, moves the withdrawal to FAILED), which happens once. The caller
 * holds the tip's lock, or nothing a dispute step locks (a payout row): disputes are locked after
 * their tips here (tip → dispute, every dispute step's order).
 *
 * Only disputes not settled (open, responded, or lost and not booked) whose hold is on the balance
 * (`share_step = balance`) and that have no transfer back of their own (that one holds by its
 * transfer back). A closed dispute's hold is for the refund (P28), never raised here. Returns what
 * was added to the disputes' protection.
 */
export async function creditDisputeHolds(
  tx: Tx,
  i: { now: Date } & (
    | { tipId: string; coverReleasedMinor: bigint }
    | { profileId: string; returningMinor: bigint }
  ),
): Promise<bigint> {
  const released = 'tipId' in i ? i.coverReleasedMinor : 0n;
  let returning = 'tipId' in i ? 0n : i.returningMinor;
  if (released <= 0n && returning <= 0n) return 0n;
  const scope =
    'tipId' in i
      ? sql`x.tip_id = ${i.tipId}`
      : sql`x.tip_id IN (SELECT t.id FROM tips t WHERE t.profile_id = ${i.profileId})`;
  const candidates = sql`x.settled_at IS NULL AND x.status IN ('open', 'responded', 'lost')
      AND x.share_step = 'balance'
      AND NOT EXISTS (SELECT 1 FROM collect_transfers b WHERE b.dispute_id = x.id AND b.kind = 'back')`;
  // Their tips first, then the disputes (no-ops for a caller already holding the tip).
  const tipIds = (
    await tx.execute<{ tip_id: string }>(sql`
      SELECT DISTINCT x.tip_id FROM disputes x WHERE ${scope} AND ${candidates}
       ORDER BY x.tip_id`)
  ).rows.map((row) => row.tip_id);
  if (tipIds.length === 0) return 0n;
  await tx
    .select({ id: tips.id })
    .from(tips)
    .where(inArray(tips.id, tipIds))
    .orderBy(asc(tips.id))
    .for('update');
  const targets = await tx
    .select()
    .from(disputes)
    .where(
      and(
        inArray(disputes.tipId, tipIds),
        isNull(disputes.settledAt),
        inArray(disputes.status, ['open', 'responded', 'lost']),
        eq(disputes.shareStep, 'balance'),
        sql`NOT EXISTS (SELECT 1 FROM collect_transfers b
                         WHERE b.dispute_id = ${disputes.id} AND b.kind = 'back')`,
      ),
    )
    .orderBy(asc(disputes.createdAt), asc(disputes.id))
    .for('update');
  // Never more than the balance has now (it already counts the money back, less every hold).
  if (returning > 0n && 'profileId' in i) {
    const { availableMinor } = await balanceIn(tx, i.profileId);
    returning = min(returning, max(availableMinor, 0n));
  }
  let added = 0n;
  const seen = new Set<string>();
  for (const target of targets) {
    // One dispute per tip takes the raise: the tip's protection is shared by its disputes.
    if (seen.has(target.tipId)) continue;
    seen.add(target.tipId);
    const [share] = await tx
      .select({
        amountMinor: collectTransfers.amountMinor,
        profileId: collectTransfers.profileId,
      })
      .from(collectTransfers)
      .where(
        and(
          eq(collectTransfers.tipId, target.tipId),
          eq(collectTransfers.kind, 'share'),
        ),
      );
    if (!share) continue;
    // The tip's parts exactly as the balance reads them (disputeHeldSql's first part).
    const [parts] = (
      await tx.execute<{ held: string; paid: string; reserved: string }>(sql`
        SELECT
          (SELECT COALESCE(SUM(x.held_minor), 0) FROM disputes x
            WHERE x.tip_id = ${target.tipId} AND x.held_minor > 0
              AND NOT EXISTS (SELECT 1 FROM collect_transfers b
                               WHERE b.dispute_id = x.id AND b.kind = 'back'))::text AS held,
          GREATEST((SELECT COALESCE(SUM(CASE c.kind WHEN 'back' THEN c.amount_minor
                                                    ELSE -c.amount_minor END), 0)
                      FROM collect_transfers c
                     WHERE c.tip_id = ${target.tipId} AND c.refund_id IS NOT NULL
                       AND c.kind IN ('back', 'return') AND c.status = 'paid'), 0)::text AS paid,
          (SELECT COALESCE(SUM(r.held_minor), 0) FROM tip_refunds r
            WHERE r.tip_id = ${target.tipId})::text AS reserved`)
    ).rows;
    const held = BigInt(parts?.held ?? '0');
    const paid = BigInt(parts?.paid ?? '0');
    const reserved = BigInt(parts?.reserved ?? '0');
    const covered = paid + reserved;
    const cap = min(share.amountMinor, target.amountMinor);
    // What protected the tip before the cover was released, and what should protect it now.
    const before = max(held, covered + released);
    const extra = min(returning, max(cap - before, 0n));
    const wanted = min(cap, before + extra);
    const raise = min(wanted - held, cap - target.heldMinor);
    if (wanted <= covered || raise <= 0n) continue;
    returning -= extra;
    added += max(wanted - before, 0n);
    await tx
      .update(disputes)
      .set({ heldMinor: target.heldMinor + raise, updatedAt: i.now })
      .where(eq(disputes.id, target.id));
    if (target.status === 'open' || target.status === 'responded')
      await tellDisputeHold(tx, {
        disputeId: target.id,
        tipId: target.tipId,
        profileId: share.profileId,
        // What the notice now reads for this tip (collectDisputeHeldMinor).
        heldMinor: max(wanted - paid, reserved),
        now: i.now,
      });
  }
  return added;
}
