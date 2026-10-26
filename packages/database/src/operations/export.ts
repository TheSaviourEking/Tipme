import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';

/** At most this many tips per file; enough for any recipient today, bounded for the server. */
export const EXPORT_LIMIT = 5000;

const HEADER = [
  'Date (Lagos)',
  'From',
  'Tip (NGN)',
  'TipMe fee (NGN)',
  'Provider fee (NGN)',
  'You received (NGN)',
  'Status',
  'Reference ends',
];

/**
 * A cell safe to open in a spreadsheet: quoted when needed, and a leading = + - @ or tab is
 * neutralised so a supporter's name can never run as a formula (CSV injection).
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * A recipient's own tips as CSV, newest first: amounts and status only, never message text.
 * Only tips the dashboard shows (paid, or genuinely confirming) are included.
 */
export function exportMyTipsCsv(
  db: Database,
  profileId: string,
): Promise<{ csv: string; rows: number }> {
  return guarded(async () => {
    const result = await db.execute<{
      at: string;
      label: string | null;
      gross: string;
      platform_fee: string;
      provider_fee: string;
      net: string;
      status: string;
      reference: string | null;
    }>(sql`
      SELECT to_char(COALESCE(t.completed_at, t.created_at) AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') AS at,
             t.payer_display_label AS label, t.gross_minor::text AS gross,
             q.platform_fee_minor::text AS platform_fee, q.provider_fee_minor::text AS provider_fee,
             q.recipient_net_minor::text AS net, t.status::text AS status,
             (SELECT a.provider_reference FROM payment_attempts a WHERE a.intent_id = t.intent_id
               ORDER BY a.created_at DESC LIMIT 1) AS reference
        FROM tips t
        JOIN payment_intents i ON i.id = t.intent_id
        JOIN tip_quotes q ON q.id = i.quote_id
       WHERE t.profile_id = ${profileId}
         AND (t.status IN ('SUCCEEDED', 'PENDING_VERIFICATION')
              OR (t.status = 'AWAITING_PAYMENT' AND EXISTS (
                    SELECT 1 FROM payment_attempts pa WHERE pa.intent_id = t.intent_id AND pa.status = 'PENDING')))
       ORDER BY COALESCE(t.completed_at, t.created_at) DESC, t.id DESC
       LIMIT ${EXPORT_LIMIT}`);
    // Plain decimal naira from integer kobo ("2000.00"), so spreadsheets read a number.
    const naira = (minor: string) => {
      const kobo = BigInt(minor);
      const sign = kobo < 0n ? '-' : '';
      const abs = kobo < 0n ? -kobo : kobo;
      return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
    };
    const lines = [HEADER.map(csvCell).join(',')];
    for (const row of result.rows)
      lines.push(
        [
          row.at,
          row.label ?? 'A guest',
          naira(row.gross),
          naira(row.platform_fee),
          naira(row.provider_fee),
          naira(row.net),
          row.status === 'SUCCEEDED' ? 'Paid' : 'Confirming',
          row.reference ? row.reference.slice(-6) : '',
        ]
          .map(csvCell)
          .join(','),
      );
    return { csv: `${lines.join('\r\n')}\r\n`, rows: result.rows.length };
  });
}
