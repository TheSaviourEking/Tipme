import type { BusinessDetail, BusinessUsage } from '@tipme/contracts';
import { businessLimits, type BusinessPlan } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { OperationError } from './errors.js';

/*
 * Business Pro limits (owner, 14 Nov 2026; plan Task A4, ruling R4). Business Free: 3 staff and 1
 * location; Business Pro: 25 of each. Staff are distinct people (pages) with an open membership at
 * any of the business's locations, open or closed, never one of its open owners; inviting also
 * counts open staff invitations. A limit only stops adding: nobody already there is removed or
 * blocked, and no tip is ever refused because of one. Checked under the business row's lock, so two
 * owners adding at once land one after the other.
 */

/** The people who take a staff seat: open members who aren't open owners. */
const seatedStaff = (businessId: string) => sql`
  SELECT DISTINCT bm.profile_id
    FROM business_members bm
    JOIN business_locations l ON l.id = bm.location_id
    JOIN profiles p ON p.id = bm.profile_id
   WHERE l.business_id = ${businessId} AND bm.left_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM business_managers m
        WHERE m.business_id = ${businessId} AND m.user_id = p.user_id
          AND m.role = 'owner' AND m.removed_at IS NULL)`;

async function countStaff(
  db: Database | Tx,
  businessId: string,
  countInvitations: boolean,
  now: Date,
): Promise<number> {
  const members = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (${seatedStaff(businessId)}) seated`);
  let used = members.rows[0]?.n ?? 0;
  if (countInvitations) {
    // An invitation to someone already seated, or to an owner, promises no new seat.
    const invited = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM business_invitations i
       WHERE i.business_id = ${businessId} AND i.kind = 'staff'
         AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
         AND i.expires_at > ${now}
         AND (i.invited_profile_id IS NULL OR i.invited_profile_id NOT IN (
               SELECT p.id FROM profiles p
                JOIN business_managers m ON m.user_id = p.user_id
               WHERE m.business_id = ${businessId} AND m.role = 'owner'
                 AND m.removed_at IS NULL
               UNION ${seatedStaff(businessId)}))`);
    used += invited.rows[0]?.n ?? 0;
  }
  return used;
}

async function countLocations(
  db: Database | Tx,
  businessId: string,
): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM business_locations
     WHERE business_id = ${businessId} AND closed_at IS NULL`);
  return result.rows[0]?.n ?? 0;
}

/** Locks the business row (callers in a transaction) and reads its plan. */
async function lockedPlan(tx: Tx, businessId: string): Promise<BusinessPlan> {
  const result = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM businesses WHERE id = ${businessId} FOR UPDATE`);
  const row = result.rows[0];
  if (!row) throw new OperationError('BUSINESS_NOT_FOUND');
  return row.plan === 'pro' ? 'pro' : 'free';
}

/** What a business uses of its plan's limits; `used` may be above `limit`. */
export async function businessUsage(
  db: Database | Tx,
  businessId: string,
  now: Date = new Date(),
): Promise<BusinessUsage> {
  const result = await db.execute<{ plan: string }>(sql`
    SELECT plan FROM businesses WHERE id = ${businessId}`);
  const row = result.rows[0];
  if (!row) throw new OperationError('BUSINESS_NOT_FOUND');
  const plan: BusinessPlan = row.plan === 'pro' ? 'pro' : 'free';
  const limits = businessLimits(plan);
  return {
    plan,
    staff: {
      used: await countStaff(db, businessId, true, now),
      limit: limits.staff,
    },
    locations: {
      used: await countLocations(db, businessId),
      limit: limits.locations,
    },
  };
}

/**
 * Refuses BUSINESS_STAFF_LIMIT when one more person would pass the plan's staff limit. Someone
 * already seated (a member at another location) or an owner takes no new seat, so they pass.
 * Takes the business row's lock first.
 */
export async function assertCanAddStaff(
  tx: Tx,
  businessId: string,
  opts: { countInvitations: boolean; profileId?: string | null; now?: Date },
): Promise<void> {
  const plan = await lockedPlan(tx, businessId);
  if (opts.profileId) {
    const seated = await tx.execute(sql`
      SELECT 1 FROM (${seatedStaff(businessId)}) seated
       WHERE seated.profile_id = ${opts.profileId}
      UNION ALL
      SELECT 1 FROM profiles p
        JOIN business_managers m ON m.user_id = p.user_id
       WHERE p.id = ${opts.profileId} AND m.business_id = ${businessId}
         AND m.role = 'owner' AND m.removed_at IS NULL
      LIMIT 1`);
    if (seated.rows.length > 0) return;
  }
  const used = await countStaff(
    tx,
    businessId,
    opts.countInvitations,
    opts.now ?? new Date(),
  );
  if (used >= businessLimits(plan).staff)
    throw new OperationError('BUSINESS_STAFF_LIMIT');
}

/** Refuses BUSINESS_LOCATION_LIMIT when one more open location would pass the plan's limit. */
export async function assertCanAddLocation(
  tx: Tx,
  businessId: string,
): Promise<void> {
  const plan = await lockedPlan(tx, businessId);
  if ((await countLocations(tx, businessId)) >= businessLimits(plan).locations)
    throw new OperationError('BUSINESS_LOCATION_LIMIT');
}

/**
 * A business's detail with its plan, usage and lapse (BUSINESS_PRO_ENABLED on). The API adds these
 * only with the flag on, so with it off the detail is exactly today's.
 */
export async function withBusinessPlan(
  db: Database,
  detail: BusinessDetail,
  now: Date = new Date(),
): Promise<BusinessDetail> {
  const usage = await businessUsage(db, detail.id, now);
  const lapsed = await db.execute<{ pro_lapsed_at: Date | string | null }>(
    sql`SELECT pro_lapsed_at FROM businesses WHERE id = ${detail.id}`,
  );
  const lapsedAt = lapsed.rows[0]?.pro_lapsed_at ?? null;
  return {
    ...detail,
    plan: usage.plan,
    usage,
    ...(lapsedAt && usage.plan === 'free'
      ? { proLapsedAt: new Date(lapsedAt).toISOString() }
      : {}),
  };
}
