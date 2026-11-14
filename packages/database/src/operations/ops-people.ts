import type {
  OpsPeoplePage,
  OpsPeopleQuery,
  OpsPerson,
  OpsPersonEmail,
} from '@tipme/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { recordAudit } from './audit.js';
import { maskEmail } from './email-address.js';
import { guarded, OperationError } from './errors.js';

// People (owner's ask, 14 Nov 2026): every account a page at a time, for search.view. One count
// and one page query, each a single statement: the per-row facts (business, payouts, last active,
// tips total) are correlated lookups on indexed foreign keys, evaluated only for the rows a sort
// or filter needs. Emails leave here masked; the full address is revealPersonEmail's, with a reason.
//
// Indexes: users' primary key for the id tiebreak; profiles.user_id (unique) and handle_lower
// (prefix index, 0037); sessions_user; payout_destinations_active (profile_id, provider) where
// not replaced; business_managers_user (open rows); tips_profile_created (profile_id, …).

/** `q` as plain text inside LIKE: its own % and _ match only themselves. */
const likeText = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

/** What every query starts from: live accounts, their (not deleted) page, release-check pages out. */
const FROM = sql`
  FROM users u
  LEFT JOIN profiles p ON p.user_id = u.id AND p.page_state <> 'deleted'
  LEFT JOIN LATERAL (
    SELECT b.name FROM business_managers m JOIN businesses b ON b.id = m.business_id
     WHERE m.user_id = u.id AND m.removed_at IS NULL
     ORDER BY m.created_at, m.id LIMIT 1
  ) biz ON true`;

const PAYOUTS_SET_UP = sql`EXISTS (
  SELECT 1 FROM payout_destinations d
   WHERE d.profile_id = p.id AND d.replaced_at IS NULL AND d.status = 'usable')`;

const TIPS_TOTAL = sql`(
  SELECT coalesce(sum(t.gross_minor), 0) FROM tips t
   WHERE t.profile_id = p.id AND t.status = 'SUCCEEDED')`;

const PAGE_STATUS = sql`CASE
  WHEN p.id IS NULL THEN 'none'
  WHEN p.status = 'suspended' THEN 'suspended'
  WHEN p.page_state = 'live' THEN 'live'
  ELSE 'offline' END`;

function conditions(query: OpsPeopleQuery, privateView: boolean): SQL {
  const where: SQL[] = [
    sql`u.deleted_at IS NULL`,
    sql`(p.id IS NULL OR p.rehearsal_run_id IS NULL)`,
  ];
  if (query.plan) where.push(sql`coalesce(p.plan, 'free') = ${query.plan}`);
  switch (query.pageStatus) {
    case 'none':
      where.push(sql`p.id IS NULL`);
      break;
    case 'suspended':
      where.push(sql`p.status = 'suspended'`);
      break;
    case 'live':
      where.push(sql`p.status = 'active' AND p.page_state = 'live'`);
      break;
    case 'offline':
      where.push(sql`p.status = 'active' AND p.page_state = 'not_live'`);
      break;
  }
  if (query.payouts === 'set_up') where.push(PAYOUTS_SET_UP);
  if (query.payouts === 'not_set_up') where.push(sql`NOT ${PAYOUTS_SET_UP}`);
  // Lagos days, both ends included.
  if (query.joinedFrom)
    where.push(
      sql`u.created_at >= (${query.joinedFrom}::date::timestamp AT TIME ZONE 'Africa/Lagos')`,
    );
  if (query.joinedTo)
    where.push(
      sql`u.created_at < ((${query.joinedTo}::date + 1)::timestamp AT TIME ZONE 'Africa/Lagos')`,
    );
  const text = (query.q ?? '').replace(/^@/, '').trim();
  if (text) {
    const like = likeText(text);
    const matches = [
      sql`p.handle_lower LIKE ${`${like.toLowerCase()}%`} ESCAPE '\\'`,
      sql`p.display_name ILIKE ${`%${like}%`} ESCAPE '\\'`,
    ];
    // A whole address only, so a search can't be used to spell one out a letter at a time.
    if (privateView && text.includes('@'))
      matches.push(sql`lower(u.email) = ${text.toLowerCase()}`);
    where.push(sql`(${sql.join(matches, sql` OR `)})`);
  }
  return sql.join(where, sql` AND `);
}

function orderBy(sort: OpsPeopleQuery['sort']): SQL {
  switch (sort) {
    case 'oldest':
      return sql`u.created_at ASC, u.id ASC`;
    case 'name':
      return sql`lower(coalesce(p.display_name, biz.name)) ASC NULLS LAST, u.created_at DESC, u.id DESC`;
    case 'most_tips':
      return sql`tips_total DESC, u.created_at DESC, u.id DESC`;
    default:
      return sql`u.created_at DESC, u.id DESC`;
  }
}

type Row = {
  id: string;
  email: string | null;
  created_at: Date | string;
  handle: string | null;
  display_name: string | null;
  business_name: string | null;
  avatar_path: string | null;
  cover_colour: string | null;
  plan: string | null;
  page_status: OpsPerson['pageStatus'];
  payouts: boolean;
  last_active: Date | string | null;
  tips_total?: string;
};
const iso = (value: Date | string) => new Date(value).toISOString();

/**
 * One page of accounts. The caller has checked `search.view`, and passes whether the viewer also
 * holds `private.view` (totals, the money sort, email search). Throws nothing for an empty page: a
 * page past the end is served as the last one.
 */
export function listOpsPeople(
  db: Database,
  query: OpsPeopleQuery,
  input: { privateView: boolean },
): Promise<OpsPeoplePage> {
  // Money is private.view's: the controller refuses the sort first, and this never serves it.
  if (query.sort === 'most_tips' && !input.privateView)
    return Promise.reject(new OperationError('INVALID_INPUT'));
  const where = conditions(query, input.privateView);
  const withTotals = input.privateView;
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const counted = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n ${FROM} WHERE ${where}`,
      );
      const total = counted.rows[0]?.n ?? 0;
      const lastPage = Math.max(1, Math.ceil(total / query.perPage));
      const page = Math.min(query.page, lastPage);
      const rows = await tx.execute<Row>(sql`
        SELECT u.id, u.email, u.created_at, p.handle, p.display_name, biz.name AS business_name,
               CASE WHEN p.status = 'active' AND p.page_state = 'live' THEN p.avatar_path END AS avatar_path,
               p.cover_colour, p.plan, ${PAGE_STATUS} AS page_status,
               ${PAYOUTS_SET_UP} AS payouts,
               (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_active
               ${withTotals ? sql`, ${TIPS_TOTAL} AS tips_total` : sql``}
          ${FROM}
         WHERE ${where}
         ORDER BY ${orderBy(query.sort)}
         LIMIT ${query.perPage} OFFSET ${(page - 1) * query.perPage}`);
      return {
        items: rows.rows.map((row) => ({
          id: row.id,
          displayName: row.display_name ?? row.business_name,
          handle: row.handle,
          avatarPath: row.avatar_path,
          coverColour: row.cover_colour,
          plan: row.plan === 'pro' ? 'pro' : 'free',
          pageStatus: row.page_status,
          payoutsSetUp: row.payouts,
          business: row.business_name !== null,
          joinedAt: iso(row.created_at),
          lastActiveAt: row.last_active ? iso(row.last_active) : null,
          email: row.email ? maskEmail(row.email) : null,
          ...(withTotals
            ? { tipsTotalMinor: String(row.tips_total ?? '0') }
            : {}),
        })),
        total,
        page,
        perPage: query.perPage,
      };
    }),
  );
}

/**
 * The full sign-in email of one account, for a `private.view` holder with a reason: audited in the
 * same transaction, as a business contact's reveal is. null when there is no such account.
 */
export function revealPersonEmail(
  db: Database,
  input: { staffUserId: string; userId: string; reason: string },
): Promise<OpsPersonEmail | null> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const found = await tx.execute<{ email: string | null }>(
        sql`SELECT email FROM users WHERE id = ${input.userId}::uuid AND deleted_at IS NULL`,
      );
      const row = found.rows[0];
      if (!row) return null;
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'people.email_revealed',
        permission: 'private.view',
        subjectType: 'user',
        subjectId: input.userId,
        reason: input.reason,
      });
      return { email: row.email };
    }),
  );
}
