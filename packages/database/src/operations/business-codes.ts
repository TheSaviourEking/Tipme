import type { BusinessCodes } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { managerOf } from './business-access.js';
import { OperationError } from './errors.js';

/**
 * The codes a manager may print (PR B8): one sign per open location in their scope, and a badge for
 * each active member there whose page is live. Nothing before TipMe verifies the business, and
 * nothing while it is suspended (M12), so no sticker goes up that leads nowhere. A badge is per
 * membership (M2): someone who left has none, and their old one leads to their own page (B4).
 */
export async function businessCodes(
  db: Database,
  userId: string,
  businessId: string,
): Promise<BusinessCodes> {
  const manager = await managerOf(db, userId, businessId);
  const business = await db.execute<{
    name: string;
    slug: string;
    status: string;
    logo_path: string | null;
  }>(
    sql`SELECT name, slug, status, logo_path FROM businesses WHERE id = ${businessId}`,
  );
  const row = business.rows[0];
  if (!row) throw new OperationError('NOT_A_MANAGER');
  if (row.status !== 'verified')
    throw new OperationError('BUSINESS_NOT_VERIFIED');
  // An owner has every location; a location manager only theirs.
  const scope =
    manager.role === 'owner' || !manager.locationId
      ? sql`TRUE`
      : sql`l.id = ${manager.locationId}`;
  const locations = await db.execute<{
    id: string;
    slug: string;
    name: string;
  }>(sql`
    SELECT l.id, l.slug, l.name
      FROM business_locations l
     WHERE l.business_id = ${businessId} AND l.closed_at IS NULL AND ${scope}
     ORDER BY l.name, l.id`);
  const staff = await db.execute<{
    member_id: string;
    location_id: string;
    location_slug: string;
    shown_name: string;
    handle: string;
  }>(sql`
    SELECT bm.id AS member_id, l.id AS location_id, l.slug AS location_slug,
           bm.shown_name, p.handle
      FROM business_members bm
      JOIN business_locations l ON l.id = bm.location_id
      JOIN profiles p ON p.id = bm.profile_id
     WHERE l.business_id = ${businessId} AND l.closed_at IS NULL AND ${scope}
       AND bm.left_at IS NULL
       AND p.status = 'active' AND p.page_state <> 'deleted'
     ORDER BY l.name, l.id, bm.shown_name, bm.id`);
  const base = `/b/${row.slug}`;
  return {
    business: {
      name: row.name,
      slug: row.slug,
      ...(row.logo_path ? { logoPath: row.logo_path } : {}),
    },
    location: locations.rows.map((location) => ({
      locationId: location.id,
      slug: location.slug,
      name: location.name,
      path: `${base}/${location.slug}?src=qr`,
    })),
    staff: staff.rows.map((member) => ({
      memberId: member.member_id,
      locationId: member.location_id,
      shownName: member.shown_name,
      path: `${base}/${member.location_slug}/${encodeURIComponent(member.handle)}?src=qr`,
    })),
  };
}
