import type {
  BusinessStatus,
  ManagerRole,
  MyBusinessRoles,
} from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

/**
 * What the dashboard needs to show the Business and Work links (PR B0): the businesses this
 * account manages, where its page works, and how many invitations wait for it. Removed managers,
 * ended memberships, used, expired and blocked invitations never count.
 */
export async function myBusinessRoles(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<MyBusinessRoles> {
  const manages = await db.execute<{
    business_id: string;
    slug: string;
    name: string;
    status: string;
    role: string;
    location_id: string | null;
  }>(sql`
    SELECT b.id AS business_id, b.slug, b.name, b.status, m.role, m.location_id
      FROM business_managers m
      JOIN businesses b ON b.id = m.business_id
     WHERE m.user_id = ${userId} AND m.removed_at IS NULL
     ORDER BY b.name, b.id`);
  const works = await db.execute<{
    member_id: string;
    business_name: string;
    location_name: string;
  }>(sql`
    SELECT bm.id AS member_id, b.name AS business_name, l.name AS location_name
      FROM business_members bm
      JOIN profiles p ON p.id = bm.profile_id
      JOIN business_locations l ON l.id = bm.location_id
      JOIN businesses b ON b.id = l.business_id
     WHERE p.user_id = ${userId} AND bm.left_at IS NULL
     ORDER BY b.name, l.name, bm.id`);
  // An email invitation counts only for the account whose sign-in address is proven and matches.
  const invitations = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM business_invitations i
      JOIN users u ON u.id = ${userId}
      LEFT JOIN profiles p ON p.user_id = u.id
     WHERE i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > ${now}
       AND (
         (i.target = 'email' AND u.email_verified_at IS NOT NULL
            AND i.email_lower = lower(u.email))
         OR (i.target = 'user' AND i.invited_profile_id = p.id)
       )
       AND NOT EXISTS (
         SELECT 1 FROM business_invitation_blocks k
          WHERE k.business_id = i.business_id AND k.user_id = u.id
       )`);
  return {
    manages: manages.rows.map((row) => ({
      businessId: row.business_id,
      slug: row.slug,
      name: row.name,
      status: row.status as BusinessStatus,
      role: row.role as ManagerRole,
      ...(row.location_id ? { locationId: row.location_id } : {}),
    })),
    works: works.rows.map((row) => ({
      memberId: row.member_id,
      businessName: row.business_name,
      locationName: row.location_name,
    })),
    invitations: invitations.rows[0]?.n ?? 0,
  };
}
