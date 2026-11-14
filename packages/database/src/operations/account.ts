import type { MyAccount } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';

// Business sign-up, Task D1: what a login knows about itself, with or without a page.

/** The login's own account; null only for a deleted login (its sessions are gone anyway). */
export function myAccount(
  db: Database,
  userId: string,
): Promise<MyAccount | null> {
  return guarded(async () => {
    const result = await db.execute<{
      email: string | null;
      email_verified_at: Date | string | null;
      handle: string | null;
      has_profile: boolean;
    }>(sql`
      SELECT u.email, u.email_verified_at, p.handle, (p.id IS NOT NULL) AS has_profile
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ${userId} AND u.deleted_at IS NULL
       LIMIT 1`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId,
      email: row.email,
      emailVerified: row.email_verified_at !== null,
      hasProfile: row.has_profile,
      handle: row.handle,
    };
  });
}

/**
 * Whether this login runs a business: an open manager row, or an open manager invitation to its
 * proven email (so an invited co-owner with no page lands where they can answer it). Staff
 * invitations never count: staff always need a page.
 */
export function managesBusiness(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return guarded(async () => {
    const result = await db.execute<{ yes: boolean }>(sql`
      SELECT EXISTS (
               SELECT 1 FROM business_managers m
                WHERE m.user_id = ${userId} AND m.removed_at IS NULL)
          OR EXISTS (
               SELECT 1 FROM business_invitations i
                 JOIN users u ON u.id = ${userId}
                 JOIN businesses b ON b.id = i.business_id
                WHERE i.kind = 'manager' AND i.target = 'email'
                  AND u.email_verified_at IS NOT NULL AND i.email_lower = lower(u.email)
                  AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
                  AND i.expires_at > ${now} AND b.status <> 'suspended'
                  AND NOT EXISTS (SELECT 1 FROM business_invitation_blocks k
                                   WHERE k.business_id = i.business_id AND k.user_id = u.id))
          AS yes`);
    return result.rows[0]?.yes === true;
  });
}
