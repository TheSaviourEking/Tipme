import { DISPUTE_HOLD_EVENT } from '@tipme/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import {
  collectTransfers,
  disputes,
  notifications,
  profiles,
} from '../schema.js';
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
 * Final review I1. A dispute that opens while a collect refund of the tip reserves the recipient's
 * balance (its transfer back not paid yet) holds only what is left after that reservation: the
 * balance counts the money once (`disputeHeldSql`, RI4). When the refund then ends without taking
 * the money (the dispute stopped it, or it failed), its reservation is handed to the dispute here,
 * so the money stays held, the recipient is told, and a loss takes it back instead of TipMe
 * absorbing it.
 *
 * Called by `failCollectRefund` in the transaction that zeroes the refund's `held_minor`, before it
 * does, with that row locked: the amount handed over is the reservation as read under that lock, and
 * it is zero afterwards, so it is handed over once. The caller holds the tip's lock first (tip →
 * dispute, the order every dispute step takes).
 *
 * Only to a dispute not settled (open, responded, or lost and its loss not booked) whose hold is on
 * the balance (`share_step = balance`) and that has no transfer back of its own (that one's hold is
 * its transfer back). A closed dispute's hold is for the refund (P28), never raised by it.
 *
 * The dispute's hold is raised so that, once the reservation is gone, what the balance holds for the
 * tip's disputes (`held − covered`, covered being the refunds' paid transfers back and
 * reservations) grows by the reservation released, never past this tip's share or the disputed
 * amount (less what was already taken back). Returns what the balance now holds for the dispute.
 */
export async function handRefundHoldToDispute(
  tx: Tx,
  i: { tipId: string; releasedMinor: bigint; now: Date },
): Promise<bigint> {
  if (i.releasedMinor <= 0n) return 0n;
  const [target] = await tx
    .select()
    .from(disputes)
    .where(
      and(
        eq(disputes.tipId, i.tipId),
        isNull(disputes.settledAt),
        inArray(disputes.status, ['open', 'responded', 'lost']),
        eq(disputes.shareStep, 'balance'),
        sql`NOT EXISTS (SELECT 1 FROM collect_transfers b
                         WHERE b.dispute_id = ${disputes.id} AND b.kind = 'back')`,
      ),
    )
    .orderBy(asc(disputes.createdAt), asc(disputes.id))
    .limit(1)
    .for('update');
  if (!target) return 0n;
  const [share] = await tx
    .select({
      amountMinor: collectTransfers.amountMinor,
      profileId: collectTransfers.profileId,
    })
    .from(collectTransfers)
    .where(
      and(
        eq(collectTransfers.tipId, i.tipId),
        eq(collectTransfers.kind, 'share'),
      ),
    );
  if (!share) return 0n;
  // The tip's parts exactly as the balance reads them (disputeHeldSql's first part).
  const [parts] = (
    await tx.execute<{ held: string; paid: string; reserved: string }>(sql`
      SELECT
        (SELECT COALESCE(SUM(x.held_minor), 0) FROM disputes x
          WHERE x.tip_id = ${i.tipId} AND x.held_minor > 0
            AND NOT EXISTS (SELECT 1 FROM collect_transfers b
                             WHERE b.dispute_id = x.id AND b.kind = 'back'))::text AS held,
        GREATEST((SELECT COALESCE(SUM(CASE c.kind WHEN 'back' THEN c.amount_minor
                                                  ELSE -c.amount_minor END), 0)
                    FROM collect_transfers c
                   WHERE c.tip_id = ${i.tipId} AND c.refund_id IS NOT NULL
                     AND c.kind IN ('back', 'return') AND c.status = 'paid'), 0)::text AS paid,
        (SELECT COALESCE(SUM(r.held_minor), 0) FROM tip_refunds r
          WHERE r.tip_id = ${i.tipId})::text AS reserved`)
  ).rows;
  const held = BigInt(parts?.held ?? '0');
  const paid = BigInt(parts?.paid ?? '0');
  const reserved = BigInt(parts?.reserved ?? '0');
  const cap = min(share.amountMinor, target.amountMinor);
  const holdingNow = max(held - paid - reserved, 0n);
  const holding = min(cap - paid, holdingNow + i.releasedMinor);
  // Once the reservation is zeroed, the balance covers the paid part and any other reservation.
  const raise = min(
    holding + paid + (reserved - i.releasedMinor) - held,
    cap - target.heldMinor,
  );
  if (raise <= 0n) return holdingNow;
  await tx
    .update(disputes)
    .set({ heldMinor: target.heldMinor + raise, updatedAt: i.now })
    .where(eq(disputes.id, target.id));
  if (target.status === 'open' || target.status === 'responded')
    await tellDisputeHold(tx, {
      disputeId: target.id,
      tipId: i.tipId,
      profileId: share.profileId,
      heldMinor: holding,
      now: i.now,
    });
  return holding;
}
