import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { balanceIn } from './balance.js';
import { guarded } from './errors.js';

/** A recipient as staff see it in search results: public identity and account state only. */
export interface OpsAccountRow {
  profileId: string;
  handle: string;
  displayName: string;
  pageState: string;
  status: string;
  createdAt: string;
}

/** One account for staff: the row plus pricing and money totals. Never phone or email. */
export interface OpsAccountDetail extends OpsAccountRow {
  role: string | null;
  suspendedReason: string | null;
  /** Staff-set fee in basis points, or null when the policy's 10% applies (ADR-0014). */
  platformFeeBps: number | null;
  feeFreeRemaining: number;
  paidTipCount: number;
  paidGrossMinor: string;
  availableMinor: string;
  confirmingMinor: string;
}

const iso = sql`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Staff search by handle (current or old) or display name. Rehearsal pages from the release
 * check are left out. Deliberately no search by phone or email: those stay private.
 */
export function searchAccounts(
  db: Database,
  input: { query: string; limit?: number },
): Promise<OpsAccountRow[]> {
  const term = input.query.trim().replace(/^@/, '').slice(0, 60);
  if (!term) return Promise.resolve([]);
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
  return guarded(async () => {
    const rows = await db.execute<{
      profile_id: string;
      handle: string;
      display_name: string;
      page_state: string;
      status: string;
      created_at: string;
    }>(sql`
      SELECT p.id AS profile_id, p.handle, p.display_name, p.page_state, p.status::text AS status,
             to_char(p.created_at AT TIME ZONE 'UTC', ${iso}) AS created_at
        FROM profiles p
       WHERE p.rehearsal_run_id IS NULL
         AND (p.handle_lower ILIKE ${like} OR p.display_name ILIKE ${like}
              OR EXISTS (SELECT 1 FROM handle_aliases a
                          WHERE a.profile_id = p.id AND a.handle_lower ILIKE ${like}))
       ORDER BY (p.handle_lower = ${term.toLowerCase()}) DESC, p.created_at DESC
       LIMIT ${limit}`);
    return rows.rows.map((row) => ({
      profileId: row.profile_id,
      handle: row.handle,
      displayName: row.display_name,
      pageState: row.page_state,
      status: row.status,
      createdAt: row.created_at,
    }));
  });
}

/** One account's summary for staff, or null when there is no such (non-rehearsal) page. */
export function accountDetail(
  db: Database,
  profileId: string,
): Promise<OpsAccountDetail | null> {
  return guarded(async () => {
    const rows = await db.execute<{
      profile_id: string;
      handle: string;
      display_name: string;
      page_state: string;
      status: string;
      created_at: string;
      role: string | null;
      suspended_reason: string | null;
      platform_fee_bps: number | null;
      fee_free_remaining: number;
      paid_count: number;
      paid_gross: string;
    }>(sql`
      SELECT p.id AS profile_id, p.handle, p.display_name, p.page_state, p.status::text AS status,
             to_char(p.created_at AT TIME ZONE 'UTC', ${iso}) AS created_at,
             p.role, p.suspended_reason, p.platform_fee_bps,
             COALESCE((SELECT remaining FROM fee_free_credits c WHERE c.profile_id = p.id), 0)
               AS fee_free_remaining,
             (SELECT count(*)::int FROM tips t WHERE t.profile_id = p.id AND t.status = 'SUCCEEDED')
               AS paid_count,
             (SELECT COALESCE(sum(t.gross_minor), 0)::text FROM tips t
               WHERE t.profile_id = p.id AND t.status = 'SUCCEEDED') AS paid_gross
        FROM profiles p
       WHERE p.id = ${profileId} AND p.rehearsal_run_id IS NULL`);
    const row = rows.rows[0];
    if (!row) return null;
    const balance = await balanceIn(db, profileId);
    return {
      profileId: row.profile_id,
      handle: row.handle,
      displayName: row.display_name,
      pageState: row.page_state,
      status: row.status,
      createdAt: row.created_at,
      role: row.role,
      suspendedReason: row.suspended_reason,
      platformFeeBps: row.platform_fee_bps,
      feeFreeRemaining: row.fee_free_remaining,
      paidTipCount: row.paid_count,
      paidGrossMinor: row.paid_gross,
      availableMinor: balance.availableMinor.toString(),
      confirmingMinor: balance.confirmingMinor.toString(),
    };
  });
}
