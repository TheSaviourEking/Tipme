import { randomUUID } from 'node:crypto';
import { SHIFT_MAX_HOURS } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { managerOf, ownMembership } from './business-access.js';
import { OperationError } from './errors.js';

// TipMe for businesses, PR B6: on shift at a location. A shift is a row in business_shifts; at
// most one is open per membership (a unique index). Nothing here runs on a timer: a shift older
// than SHIFT_MAX_HOURS reads as ended everywhere (`onShift`), and the next start or end closes it
// as 'expired' at the moment it ran out, so team tips (release 2) can read who was on when.

/** Who is acting: the person themselves, or a manager of the member's business. */
export type ShiftActor =
  | { userId: string; as: 'self' }
  | { userId: string; as: 'manager'; businessId: string };

/** What a start or an end changed, so the caller can refresh the business's public pages. */
export interface ShiftChange {
  /** The business's slug, for the web revalidation of `/b/<slug>/…`. */
  businessSlug: string;
  /** False when nothing changed (already on, or already off). */
  changed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemberContext = {
  member_id: string;
  location_id: string;
  business_id: string;
  business_slug: string;
  business_status: string;
  closed_at: Date | string | null;
};

/**
 * The open membership the actor may act on, locked for the rest of the transaction, so two
 * presses at once queue on the row instead of racing on the shift.
 */
async function memberFor(
  tx: Tx,
  actor: ShiftActor,
  memberId: string,
): Promise<MemberContext> {
  let scope: { role: string; locationId: string | null } | null = null;
  if (actor.as === 'self') await ownMembership(tx, actor.userId, memberId);
  else {
    // Not a manager of this business reads exactly like an unknown business (rule 2).
    scope = await managerOf(tx, actor.userId, actor.businessId);
    if (!UUID.test(memberId)) throw new OperationError('NO_MEMBERSHIP');
  }
  const result = await tx.execute<MemberContext>(sql`
    SELECT bm.id AS member_id, bm.location_id, l.business_id, b.slug AS business_slug,
           b.status AS business_status, l.closed_at
      FROM business_members bm
      JOIN business_locations l ON l.id = bm.location_id
      JOIN businesses b ON b.id = l.business_id
     WHERE bm.id = ${memberId} AND bm.left_at IS NULL
     FOR UPDATE OF bm`);
  const row = result.rows[0];
  if (!row) throw new OperationError('NO_MEMBERSHIP');
  if (actor.as === 'manager') {
    // Another business's member is as unknown as no member; a location manager acts only on
    // their own location.
    if (row.business_id !== actor.businessId)
      throw new OperationError('NO_MEMBERSHIP');
    if (scope?.role !== 'owner' && scope?.locationId !== row.location_id)
      throw new OperationError('NOT_A_MANAGER');
  }
  return row;
}

/** Closes this member's open shift if it ran out, as ended when it ran out. */
async function expireOpen(
  tx: Database | Tx,
  memberId: string | null,
  now: Date,
): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE business_shifts
       SET ended_at = started_at + make_interval(hours => ${SHIFT_MAX_HOURS}),
           ended_by = 'expired'
     WHERE ended_at IS NULL
       AND started_at < ${now}::timestamptz - make_interval(hours => ${SHIFT_MAX_HOURS})
       ${memberId ? sql`AND member_id = ${memberId}` : sql``}`);
  return result.rowCount ?? 0;
}

/** Closes every open shift that has run out. Reads never need it (they use `onShift`). */
export function expireShifts(
  db: Database | Tx,
  now: Date = new Date(),
): Promise<number> {
  return expireOpen(db, null, now);
}

/**
 * Puts a member on shift. Idempotent: an open, still-valid shift is returned as it is. An open
 * shift that ran out is closed 'expired' first. Refused at a closed location (not found) and at a
 * business that is not verified (BUSINESS_NOT_VERIFIED): nobody can be tipped there.
 */
export async function startShift(
  db: Database,
  actor: ShiftActor,
  memberId: string,
  now: Date = new Date(),
): Promise<{ startedAt: string } & ShiftChange> {
  return db.transaction(async (tx) => {
    const member = await memberFor(tx, actor, memberId);
    if (member.closed_at !== null) throw new OperationError('NO_MEMBERSHIP');
    if (member.business_status !== 'verified')
      throw new OperationError('BUSINESS_NOT_VERIFIED');
    await expireOpen(tx, member.member_id, now);
    const open = await tx.execute<{ started_at: Date | string }>(sql`
      SELECT started_at FROM business_shifts
       WHERE member_id = ${member.member_id} AND ended_at IS NULL`);
    const existing = open.rows[0];
    if (existing)
      return {
        startedAt: new Date(existing.started_at).toISOString(),
        businessSlug: member.business_slug,
        changed: false,
      };
    // The row lock already queues a second press; the unique index is the last word.
    const inserted = await tx.execute<{ started_at: Date | string }>(sql`
      INSERT INTO business_shifts (id, member_id, started_at, started_by)
      VALUES (${randomUUID()}, ${member.member_id}, ${now}, ${actor.as})
      ON CONFLICT (member_id) WHERE ended_at IS NULL DO NOTHING
      RETURNING started_at`);
    const row =
      inserted.rows[0] ??
      (
        await tx.execute<{ started_at: Date | string }>(sql`
          SELECT started_at FROM business_shifts
           WHERE member_id = ${member.member_id} AND ended_at IS NULL`)
      ).rows[0];
    if (!row) throw new Error('shift start found no open shift');
    return {
      startedAt: new Date(row.started_at).toISOString(),
      businessSlug: member.business_slug,
      changed: inserted.rows.length > 0,
    };
  });
}

/**
 * Takes a member off shift. No open shift is a no-op. Allowed at a closed location or a paused
 * business: ending a shift only ever hides someone.
 */
export async function endShift(
  db: Database,
  actor: ShiftActor,
  memberId: string,
  now: Date = new Date(),
): Promise<ShiftChange> {
  return db.transaction(async (tx) => {
    const member = await memberFor(tx, actor, memberId);
    // A shift that already ran out ends as it did, not now.
    await expireOpen(tx, member.member_id, now);
    const ended = await tx.execute(sql`
      UPDATE business_shifts SET ended_at = ${now}, ended_by = ${actor.as}
       WHERE member_id = ${member.member_id} AND ended_at IS NULL`);
    return {
      businessSlug: member.business_slug,
      // An expired shift was already off the public page, and is closed above.
      changed: (ended.rowCount ?? 0) > 0,
    };
  });
}
