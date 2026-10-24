import type { OpsSearchResult } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';
import { opsPageByHandle } from './profiles.js';

// Admin search (PR-013, PRD v1.1 FR-09). Finds pages by handle or name, and tips, payouts and
// ledger transactions by id or the end of a provider reference. Returns ids and short labels
// only: never phone numbers, emails, supporter names or messages.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 10;
/** `q` as plain text inside LIKE: its own % and _ match only themselves. */
const likeText = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

type Row = Record<string, unknown>;
const iso = (value: unknown) => new Date(String(value)).toISOString();

export function opsSearch(db: Database, raw: string): Promise<OpsSearchResult> {
  const q = raw.trim();
  const id = UUID.test(q) ? q.toLowerCase() : null;
  const text = likeText(q);
  // A reference ending: at least 4 characters, so a short query does not match everything.
  const ending = q.length >= 4 ? `%${text}` : null;
  return guarded(async () => {
    const rows = async (query: ReturnType<typeof sql>) =>
      (await db.execute(query)).rows as Row[];

    const pageRows = await rows(sql`
      SELECT p.id, p.handle, p.display_name, p.plan, p.page_state, p.status
        FROM profiles p
       WHERE p.page_state <> 'deleted' AND (
             p.handle_lower LIKE ${`${text.toLowerCase()}%`} ESCAPE '\\'
          OR p.display_name ILIKE ${`%${text}%`} ESCAPE '\\'
          ${id ? sql`OR p.id = ${id}::uuid` : sql``})
       ORDER BY p.handle_lower LIMIT ${LIMIT}`);
    const pages = pageRows.map((p) => ({
      profileId: String(p['id']),
      handle: String(p['handle']),
      displayName: String(p['display_name']),
      plan: p['plan'] as 'free' | 'pro',
      pageState: p['page_state'] as 'live' | 'not_live' | 'deleted',
      suspended: p['status'] === 'suspended',
    }));
    // An old handle (PR-011) finds the page it now belongs to.
    if (pages.length === 0) {
      const renamed = await opsPageByHandle(db, q);
      if (renamed) pages.push(renamed);
    }

    const tipRows =
      id || ending
        ? await rows(sql`
      SELECT DISTINCT t.id, p.handle, t.status, t.gross_minor::text AS gross, t.currency, t.created_at
        FROM tips t
        LEFT JOIN profiles p ON p.id = t.profile_id
        LEFT JOIN payment_attempts a ON a.intent_id = t.intent_id
       WHERE ${id ? sql`t.id = ${id}::uuid OR t.intent_id = ${id}::uuid` : sql`false`}
          ${ending ? sql`OR a.provider_reference ILIKE ${ending} ESCAPE '\\'` : sql``}
       ORDER BY t.created_at DESC LIMIT ${LIMIT}`)
        : [];
    const payoutRows =
      id || ending
        ? await rows(sql`
      SELECT o.id, p.handle, o.status, o.amount_minor::text AS amount, o.currency, o.created_at
        FROM payouts o LEFT JOIN profiles p ON p.id = o.profile_id
       WHERE ${id ? sql`o.id = ${id}::uuid` : sql`false`}
          ${ending ? sql`OR o.provider_reference ILIKE ${ending} ESCAPE '\\'` : sql``}
       ORDER BY o.created_at DESC LIMIT ${LIMIT}`)
        : [];
    const ledgerRows = id
      ? await rows(sql`
      SELECT id, operation_type, tip_id, payout_id, posted_at
        FROM ledger_transactions
       WHERE id = ${id}::uuid OR tip_id = ${id}::uuid OR payout_id = ${id}::uuid
       ORDER BY posted_at DESC LIMIT ${LIMIT}`)
      : [];

    return {
      pages,
      tips: tipRows.map((t) => ({
        tipId: String(t['id']),
        handle: (t['handle'] as string | null) ?? null,
        status: String(t['status']),
        grossMinor: String(t['gross']),
        currency: String(t['currency']),
        at: iso(t['created_at']),
      })),
      payouts: payoutRows.map((o) => ({
        payoutId: String(o['id']),
        handle: (o['handle'] as string | null) ?? null,
        status: String(o['status']),
        amountMinor: String(o['amount']),
        currency: String(o['currency']),
        at: iso(o['created_at']),
      })),
      ledgerTransactions: ledgerRows.map((l) => ({
        transactionId: String(l['id']),
        operationType: String(l['operation_type']),
        tipId: (l['tip_id'] as string | null) ?? null,
        payoutId: (l['payout_id'] as string | null) ?? null,
        at: iso(l['posted_at']),
      })),
    };
  });
}
