import { splitShare } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { tipBusinessShares } from '../schema.js';
import { tippableMember } from './business-access.js';

/**
 * Business release 2, PR R2-C2: the share agreement in force for a tip made at this membership now
 * (the database's `tipme_share_agreement_at`, the one meaning of "in force" the share trigger also
 * uses). Null for a tip through the person's own page, a membership that doesn't hold, or a split
 * where the person keeps everything (100/0): no share is ever fixed for those.
 */
export async function shareInForce(
  tx: Database | Tx,
  profileId: string,
  memberId: string | undefined,
): Promise<{
  agreementId: string;
  businessId: string;
  businessBps: number;
  businessName: string;
} | null> {
  const member = await tippableMember(tx, profileId, memberId);
  if (!member) return null;
  const result = await tx.execute<{
    id: string;
    business_id: string;
    business_bps: number;
    name: string;
  }>(sql`
    SELECT a.id, l.business_id, a.business_bps, b.name
      FROM share_agreements a
      JOIN business_members m ON m.id = a.member_id
      JOIN business_locations l ON l.id = m.location_id
      JOIN businesses b ON b.id = l.business_id
     WHERE a.id = tipme_share_agreement_at(${member.memberId}, now())`);
  const row = result.rows[0];
  if (!row || row.business_bps <= 0) return null;
  return {
    agreementId: row.id,
    businessId: row.business_id,
    businessBps: row.business_bps,
    businessName: row.name,
  };
}

/**
 * Fixes the share on a new tip (append-only): exactly the agreed part of what the person receives
 * after TipMe's fee (Q9), rounded down to the kobo so the remainder stays with them. The database
 * trigger checks the same arithmetic and that the agreement was in force when the tip was made.
 * A share that rounds to nothing is not fixed.
 */
export async function fixShareOnTip(
  tx: Tx,
  input: {
    tipId: string;
    agreementId: string;
    businessId: string;
    businessBps: number;
    recipientNetMinor: bigint;
  },
): Promise<bigint> {
  const { businessMinor } = splitShare(
    input.recipientNetMinor,
    input.businessBps,
  );
  if (businessMinor <= 0n) return 0n;
  await tx.insert(tipBusinessShares).values({
    tipId: input.tipId,
    agreementId: input.agreementId,
    businessId: input.businessId,
    businessBps: input.businessBps,
    shareMinor: businessMinor,
  });
  return businessMinor;
}

/**
 * What a staff member has shared with each business they work at (their own view, never the
 * business's): the shares of their paid tips there this Lagos month, and in all. A refunded tip's
 * share is left out, since it went back.
 */
export async function mySharedTips(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<
  {
    memberId: string;
    businessName: string;
    monthMinor: bigint;
    monthTips: number;
    totalMinor: bigint;
  }[]
> {
  const result = await db.execute<{
    member_id: string;
    name: string;
    month_minor: string;
    month_tips: number;
    total_minor: string;
  }>(sql`
    SELECT m.id AS member_id, b.name,
           COALESCE(SUM(s.share_minor) FILTER (
             WHERE date_trunc('month', t.created_at AT TIME ZONE 'Africa/Lagos')
                 = date_trunc('month', ${now.toISOString()}::timestamptz AT TIME ZONE 'Africa/Lagos')), 0)::text AS month_minor,
           (COUNT(*) FILTER (
             WHERE date_trunc('month', t.created_at AT TIME ZONE 'Africa/Lagos')
                 = date_trunc('month', ${now.toISOString()}::timestamptz AT TIME ZONE 'Africa/Lagos')))::int AS month_tips,
           COALESCE(SUM(s.share_minor), 0)::text AS total_minor
      FROM business_members m
      JOIN profiles p ON p.id = m.profile_id
      JOIN business_locations l ON l.id = m.location_id
      JOIN businesses b ON b.id = l.business_id
      JOIN tips t ON t.business_member_id = m.id AND t.status = 'SUCCEEDED'
      JOIN tip_business_shares s ON s.tip_id = t.id
     WHERE p.user_id = ${userId}
       AND NOT EXISTS (SELECT 1 FROM ledger_transactions r
                        WHERE r.tip_id = t.id AND r.operation_type = 'reversal')
     GROUP BY m.id, b.name
     ORDER BY b.name`);
  return result.rows.map((row) => ({
    memberId: row.member_id,
    businessName: row.name,
    monthMinor: BigInt(row.month_minor),
    monthTips: row.month_tips,
    totalMinor: BigInt(row.total_minor),
  }));
}
