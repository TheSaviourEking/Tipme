import type {
  BusinessStatus,
  MemberDisplay,
  MemberRow,
  MyMembership,
} from '@tipme/contracts';
import { onShift } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { managerOf, ownMembership } from './business-access.js';
import { guarded, OperationError } from './errors.js';

// TipMe for businesses, PR B3: who is on a location's team, and how a person shows there. Leaving
// or being removed is instant and touches nothing of the person's own: their tips, balance and
// notes stay where they are (spec 8); only the membership row and its open shift end.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MembershipRow = {
  member_id: string;
  business_id: string;
  business_name: string;
  business_slug: string;
  business_status: string;
  location_id: string;
  location_name: string;
  location_slug: string;
  shown_name: string;
  show_photo: boolean;
  share_amounts: boolean;
  handle: string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
};

const asDate = (value: Date | string | null) =>
  value === null ? null : value instanceof Date ? value : new Date(value);

function membershipView(row: MembershipRow, now: Date): MyMembership {
  const startedAt = asDate(row.started_at);
  const shift = startedAt ? { startedAt, endedAt: asDate(row.ended_at) } : null;
  const shifting = onShift(shift, now);
  return {
    memberId: row.member_id,
    business: {
      id: row.business_id,
      name: row.business_name,
      slug: row.business_slug,
      status: row.business_status as BusinessStatus,
    },
    location: {
      id: row.location_id,
      name: row.location_name,
      slug: row.location_slug,
    },
    shownName: row.shown_name,
    showPhoto: row.show_photo,
    shareAmounts: row.share_amounts,
    onShift: shifting,
    ...(shifting && startedAt
      ? { shiftStartedAt: startedAt.toISOString() }
      : {}),
    staffCodePath: `/b/${row.business_slug}/${row.location_slug}/${row.handle}`,
  };
}

/** The signed-in person's open memberships, or one of them. */
async function memberships(
  db: Database | Tx,
  userId: string,
  now: Date,
  memberId?: string,
): Promise<MyMembership[]> {
  const result = await db.execute<MembershipRow>(sql`
    SELECT bm.id AS member_id, b.id AS business_id, b.name AS business_name,
           b.slug AS business_slug, b.status AS business_status,
           l.id AS location_id, l.name AS location_name, l.slug AS location_slug,
           bm.shown_name, bm.show_photo, bm.share_amounts, p.handle,
           s.started_at, s.ended_at
      FROM business_members bm
      JOIN profiles p ON p.id = bm.profile_id
      JOIN business_locations l ON l.id = bm.location_id
      JOIN businesses b ON b.id = l.business_id
      LEFT JOIN business_shifts s ON s.member_id = bm.id AND s.ended_at IS NULL
     WHERE p.user_id = ${userId} AND bm.left_at IS NULL
       ${memberId ? sql`AND bm.id = ${memberId}` : sql``}
     ORDER BY b.name, l.name, bm.id`);
  return result.rows.map((row) => membershipView(row, now));
}

/** One membership of the signed-in person, as the Work page shows it. */
export async function myMembership(
  db: Database | Tx,
  userId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<MyMembership> {
  const [found] = await memberships(db, userId, now, memberId);
  if (!found) throw new OperationError('NO_MEMBERSHIP');
  return found;
}

/** Where the signed-in person's page works. */
export function myWork(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<MyMembership[]> {
  return guarded(() => memberships(db, userId, now));
}

/** Ends a membership and its open shift, in the caller's transaction. */
async function endMembership(
  tx: Tx,
  memberId: string,
  leftBy: 'self' | 'manager' | 'account_deleted',
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE business_shifts SET ended_at = ${now}, ended_by = 'left'
     WHERE member_id = ${memberId} AND ended_at IS NULL`);
  await tx.execute(sql`
    UPDATE business_members SET left_at = ${now}, left_by = ${leftBy}
     WHERE id = ${memberId} AND left_at IS NULL`);
}

/**
 * The open team of a business: every location for an owner (or the one asked for), only their own
 * for a location manager. Another business's id, or a location outside the manager's, is 404.
 */
export function listMembers(
  db: Database,
  userId: string,
  businessId: string,
  locationId?: string,
  now: Date = new Date(),
): Promise<MemberRow[]> {
  return guarded(async () => {
    const manager = await managerOf(
      db,
      userId,
      businessId,
      locationId ? { locationId } : {},
    );
    const only = locationId ?? manager.locationId;
    const result = await db.execute<{
      member_id: string;
      handle: string;
      shown_name: string;
      show_photo: boolean;
      joined_at: Date | string;
      location_id: string;
      started_at: Date | string | null;
    }>(sql`
      SELECT bm.id AS member_id, p.handle, bm.shown_name, bm.show_photo, bm.joined_at,
             bm.location_id, s.started_at
        FROM business_members bm
        JOIN business_locations l ON l.id = bm.location_id
        JOIN profiles p ON p.id = bm.profile_id
        LEFT JOIN business_shifts s ON s.member_id = bm.id AND s.ended_at IS NULL
       WHERE l.business_id = ${businessId} AND bm.left_at IS NULL
         ${only ? sql`AND bm.location_id = ${only}` : sql``}
       ORDER BY bm.shown_name, bm.id`);
    return result.rows.map((row) => {
      const startedAt = asDate(row.started_at);
      return {
        memberId: row.member_id,
        profileHandle: row.handle,
        shownName: row.shown_name,
        showPhoto: row.show_photo,
        onShift: onShift(startedAt ? { startedAt, endedAt: null } : null, now),
        joinedAt: (asDate(row.joined_at) as Date).toISOString(),
        locationId: row.location_id,
      };
    });
  });
}

/** A manager takes someone off a location's team (left_by 'manager'). Instant. */
export function removeMember(
  db: Database,
  userId: string,
  businessId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      if (!UUID.test(memberId)) {
        await managerOf(tx, userId, businessId);
        throw new OperationError('NO_MEMBERSHIP');
      }
      const found = await tx.execute<{ location_id: string }>(sql`
        SELECT bm.location_id
          FROM business_members bm
          JOIN business_locations l ON l.id = bm.location_id
         WHERE bm.id = ${memberId} AND l.business_id = ${businessId}
           AND bm.left_at IS NULL
         FOR UPDATE OF bm`);
      // Not a manager here reads as an unknown business; not on this team, as an unknown member.
      const row = found.rows[0];
      await managerOf(
        tx,
        userId,
        businessId,
        row ? { locationId: row.location_id } : {},
      );
      if (!row) throw new OperationError('NO_MEMBERSHIP');
      await endMembership(tx, memberId, 'manager', now);
    }),
  );
}

/** The person leaves a location (left_by 'self'). Instant; their tips and balance stay theirs. */
export function leaveBusiness(
  db: Database,
  userId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await ownMembership(tx, userId, memberId);
      await endMembership(tx, memberId, 'self', now);
    }),
  );
}

/** How the person shows at one location: the name on their card, and whether their photo shows. */
export function updateMyMembership(
  db: Database,
  userId: string,
  memberId: string,
  patch: MemberDisplay,
  now: Date = new Date(),
): Promise<MyMembership> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await ownMembership(tx, userId, memberId);
      if (patch.shownName !== undefined || patch.showPhoto !== undefined)
        await tx.execute(sql`
          UPDATE business_members
             SET shown_name = ${patch.shownName ?? sql`shown_name`},
                 show_photo = ${patch.showPhoto ?? sql`show_photo`}
           WHERE id = ${memberId}`);
      return myMembership(tx, userId, memberId, now);
    }),
  );
}

/**
 * Account deletion's part (M13), inside `deleteAccount`'s transaction and before anything is
 * erased: refuses while the person is the only owner of a verified (or since suspended) business,
 * then ends their memberships and shifts, their manager seats, and their invitation blocks.
 */
export async function endBusinessRolesForDeletion(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<void> {
  // Each owned business's row is locked first, so two owners deleting at once can't both pass.
  const owned = await tx.execute<{ id: string }>(sql`
    SELECT b.id FROM businesses b
     WHERE b.status <> 'pending'
       AND EXISTS (SELECT 1 FROM business_managers m
                    WHERE m.business_id = b.id AND m.user_id = ${userId}
                      AND m.role = 'owner' AND m.removed_at IS NULL)
     ORDER BY b.id
       FOR UPDATE OF b`);
  for (const { id } of owned.rows) {
    const others = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM business_managers m
        JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
       WHERE m.business_id = ${id} AND m.role = 'owner' AND m.removed_at IS NULL
         AND m.user_id <> ${userId}`);
    if ((others.rows[0]?.n ?? 0) === 0)
      throw new OperationError('BUSINESS_LAST_OWNER');
  }
  const open = await tx.execute<{ id: string }>(sql`
    SELECT bm.id FROM business_members bm
      JOIN profiles p ON p.id = bm.profile_id
     WHERE p.user_id = ${userId} AND bm.left_at IS NULL
       FOR UPDATE OF bm`);
  for (const { id } of open.rows)
    await endMembership(tx, id, 'account_deleted', now);
  await tx.execute(sql`
    UPDATE business_managers SET removed_at = ${now}
     WHERE user_id = ${userId} AND removed_at IS NULL`);
  await tx.execute(sql`
    DELETE FROM business_invitation_blocks WHERE user_id = ${userId}`);
}
