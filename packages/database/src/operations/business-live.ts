import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a committed business change is about: the business, one membership, or a tip made there. */
export type BusinessLiveRef =
  { businessId: string } | { memberId: string } | { tipId: string };

/**
 * Who should re-read after a business change (plan B9 Task 23): the business's open managers and
 * the accounts of its current team, plus the person a membership or tip is about (even once they
 * left, so their own Work page updates). Never anyone of another business. User ids only, for
 * `{ user }` live signals; nothing here is logged or sent to a browser.
 */
export function businessLiveAudience(
  db: Database,
  ref: BusinessLiveRef,
): Promise<string[]> {
  const id =
    'businessId' in ref
      ? ref.businessId
      : 'memberId' in ref
        ? ref.memberId
        : ref.tipId;
  if (!UUID.test(id)) return Promise.resolve([]);
  return guarded(async () => {
    // The membership the change is about, when there is one: a tip's checked label, or the member.
    const subject =
      'businessId' in ref
        ? sql`SELECT NULL::uuid AS member_id, ${id}::uuid AS business_id`
        : sql`SELECT m.id AS member_id, l.business_id
                FROM business_members m
                JOIN business_locations l ON l.id = m.location_id
               WHERE m.id = ${
                 'memberId' in ref
                   ? sql`${id}::uuid`
                   : sql`(SELECT business_member_id FROM tips WHERE id = ${id}::uuid)`
               }`;
    const { rows } = await db.execute<{ user_id: string }>(sql`
      WITH subject AS (${subject})
      SELECT bm.user_id FROM business_managers bm, subject s
       WHERE bm.business_id = s.business_id AND bm.removed_at IS NULL
      UNION
      SELECT p.user_id FROM business_members m
        JOIN business_locations l ON l.id = m.location_id
        JOIN profiles p ON p.id = m.profile_id
        JOIN subject s ON s.business_id = l.business_id
       WHERE m.left_at IS NULL OR m.id = s.member_id`);
    return rows.map((row) => row.user_id).filter(Boolean);
  });
}
