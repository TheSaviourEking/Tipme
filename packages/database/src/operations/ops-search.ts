import type { OpsSearchResult } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { guarded } from './errors.js';
import { opsPageByHandle } from './profiles.js';

// Admin search (PR-013, PRD v1.1 FR-09). Finds pages by handle, name or old handle, and tips,
// payouts and ledger transactions by id, by a whole provider reference, or by the 6-character
// reference ending staff see in the evidence. Returns ids and short labels only: never phone
// numbers, emails, supporter names or messages.
//
// Every lookup uses an index (ids, references, the reference-ending and handle-prefix indexes
// of migration 0037) except the name search, and the whole search stops after 3 seconds.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 10;
/** `q` as plain text inside LIKE: its own % and _ match only themselves. */
const likeText = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

type Row = Record<string, unknown>;
const iso = (value: unknown) => new Date(String(value)).toISOString();

const pageOf = (p: Row): OpsSearchResult['pages'][number] => ({
  profileId: String(p['id']),
  handle: String(p['handle']),
  displayName: String(p['display_name']),
  plan: p['plan'] as 'free' | 'pro',
  pageState: p['page_state'] as 'live' | 'not_live' | 'deleted',
  suspended: p['status'] === 'suspended',
});

export function opsSearch(db: Database, raw: string): Promise<OpsSearchResult> {
  const q = raw.trim();
  const id = UUID.test(q) ? q.toLowerCase() : null;
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return id ? byId(tx, id) : byText(tx, q);
    }),
  );
}

const rowsOf = async (tx: Tx, query: ReturnType<typeof sql>) =>
  (await tx.execute(query)).rows as Row[];

/** An id: only the id lookups, each on a primary key or a foreign-key column. */
async function byId(tx: Tx, id: string): Promise<OpsSearchResult> {
  const pages = await rowsOf(
    tx,
    sql`SELECT id, handle, display_name, plan, page_state, status FROM profiles
         WHERE id = ${id}::uuid AND page_state <> 'deleted'`,
  );
  const tips = await rowsOf(
    tx,
    sql`SELECT t.id, p.handle, t.status, t.gross_minor::text AS gross, t.currency, t.created_at
          FROM tips t LEFT JOIN profiles p ON p.id = t.profile_id
         WHERE t.id = ${id}::uuid
        UNION
        SELECT t.id, p.handle, t.status, t.gross_minor::text, t.currency, t.created_at
          FROM tips t LEFT JOIN profiles p ON p.id = t.profile_id
         WHERE t.intent_id = ${id}::uuid
         LIMIT ${LIMIT}`,
  );
  const payouts = await rowsOf(
    tx,
    sql`SELECT o.id, p.handle, o.status, o.amount_minor::text AS amount, o.currency, o.created_at
          FROM payouts o LEFT JOIN profiles p ON p.id = o.profile_id
         WHERE o.id = ${id}::uuid`,
  );
  const ledger = await rowsOf(
    tx,
    sql`SELECT id, operation_type, tip_id, payout_id, posted_at FROM ledger_transactions
         WHERE id = ${id}::uuid
        UNION
        SELECT id, operation_type, tip_id, payout_id, posted_at FROM ledger_transactions
         WHERE tip_id = ${id}::uuid
        UNION
        SELECT id, operation_type, tip_id, payout_id, posted_at FROM ledger_transactions
         WHERE payout_id = ${id}::uuid
         ORDER BY posted_at DESC LIMIT ${LIMIT}`,
  );
  return shape(pages.map(pageOf), tips, payouts, ledger);
}

/**
 * Text: a handle prefix or a name (pages), and a whole reference or its exact 6-character
 * ending (tips and payouts). A longer partial ending matches nothing, so the search cannot
 * rebuild a reference staff are not shown.
 */
async function byText(tx: Tx, q: string): Promise<OpsSearchResult> {
  const text = likeText(q);
  const pageRows = await rowsOf(
    tx,
    sql`SELECT id, handle, display_name, plan, page_state, status FROM profiles
         WHERE page_state <> 'deleted' AND handle_lower LIKE ${`${text.toLowerCase()}%`} ESCAPE '\\'
        UNION
        SELECT id, handle, display_name, plan, page_state, status FROM profiles
         WHERE page_state <> 'deleted' AND display_name ILIKE ${`%${text}%`} ESCAPE '\\'
         ORDER BY handle LIMIT ${LIMIT}`,
  );
  const pages = pageRows.map(pageOf);
  // An old handle (PR-011) finds the page it now belongs to.
  if (pages.length === 0) {
    const renamed = await opsPageByHandle(tx, q);
    if (renamed) pages.push(renamed);
  }
  const ending = q.length === 6 ? q.toLowerCase() : null;
  const tips = await rowsOf(
    tx,
    sql`SELECT t.id, p.handle, t.status, t.gross_minor::text AS gross, t.currency, t.created_at
          FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
          LEFT JOIN profiles p ON p.id = t.profile_id
         WHERE a.provider_reference = ${q}
        ${
          ending
            ? sql`UNION
        SELECT t.id, p.handle, t.status, t.gross_minor::text, t.currency, t.created_at
          FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
          LEFT JOIN profiles p ON p.id = t.profile_id
         WHERE lower(right(a.provider_reference, 6)) = ${ending}`
            : sql``
        }
         LIMIT ${LIMIT}`,
  );
  const payouts = await rowsOf(
    tx,
    sql`SELECT o.id, p.handle, o.status, o.amount_minor::text AS amount, o.currency, o.created_at
          FROM payouts o LEFT JOIN profiles p ON p.id = o.profile_id
         WHERE o.provider_reference = ${q}
        ${
          ending
            ? sql`UNION
        SELECT o.id, p.handle, o.status, o.amount_minor::text, o.currency, o.created_at
          FROM payouts o LEFT JOIN profiles p ON p.id = o.profile_id
         WHERE lower(right(o.provider_reference, 6)) = ${ending}`
            : sql``
        }
         LIMIT ${LIMIT}`,
  );
  return shape(pages, tips, payouts, []);
}

function shape(
  pages: OpsSearchResult['pages'],
  tips: Row[],
  payouts: Row[],
  ledger: Row[],
): OpsSearchResult {
  return {
    pages,
    tips: tips.map((t) => ({
      tipId: String(t['id']),
      handle: (t['handle'] as string | null) ?? null,
      status: String(t['status']),
      grossMinor: String(t['gross']),
      currency: String(t['currency']),
      at: iso(t['created_at']),
    })),
    payouts: payouts.map((o) => ({
      payoutId: String(o['id']),
      handle: (o['handle'] as string | null) ?? null,
      status: String(o['status']),
      amountMinor: String(o['amount']),
      currency: String(o['currency']),
      at: iso(o['created_at']),
    })),
    ledgerTransactions: ledger.map((l) => ({
      transactionId: String(l['id']),
      operationType: String(l['operation_type']),
      tipId: (l['tip_id'] as string | null) ?? null,
      payoutId: (l['payout_id'] as string | null) ?? null,
      at: iso(l['posted_at']),
    })),
  };
}
