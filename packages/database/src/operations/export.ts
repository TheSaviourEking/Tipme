import { BUSINESS_NOTE_TAGS } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';

/** At most this many tips per file; enough for any recipient today, bounded for the server. */
export const EXPORT_LIMIT = 5000;

const HEADER = [
  'Date (Lagos)',
  'From',
  'Tip (NGN)',
  'TipMe fee, processing included (NGN)',
  'You received (NGN)',
  'Status',
  'Reference ends',
  // TipMe for businesses (plan B9 Task 24): where a tip was made, and the note written about you.
  'At a business',
  'Note tags',
  'Note',
];

const TAG_LABELS: ReadonlyMap<string, string> = new Map(
  BUSINESS_NOTE_TAGS.map((tag) => [tag.id, tag.label]),
);

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
 * Only tips the dashboard shows (paid, or genuinely confirming) are included. A tip made at a
 * business names it and carries the note written about the person, as their Work page shows it:
 * a note TipMe removed keeps its place with its words and tags held back.
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
      fee: string;
      net: string;
      status: string;
      reference: string | null;
      business: string | null;
      location: string | null;
      tags: string[] | null;
      body: string | null;
      outcome: string | null;
    }>(sql`
      SELECT to_char(COALESCE(t.completed_at, t.created_at) AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') AS at,
             t.payer_display_label AS label, t.gross_minor::text AS gross,
             (q.platform_fee_minor + q.provider_fee_minor)::text AS fee,
             q.recipient_net_minor::text AS net, t.status::text AS status,
             (SELECT a.provider_reference FROM payment_attempts a WHERE a.intent_id = t.intent_id
               ORDER BY a.created_at DESC LIMIT 1) AS reference,
             b.name AS business, l.name AS location, n.tags, n.body, f.outcome
        FROM tips t
        JOIN payment_intents i ON i.id = t.intent_id
        JOIN tip_quotes q ON q.id = i.quote_id
        LEFT JOIN business_locations l ON l.id = t.business_location_id
        LEFT JOIN businesses b ON b.id = l.business_id
        LEFT JOIN business_notes n ON n.tip_id = t.id
        LEFT JOIN business_note_flags f ON f.tip_id = t.id
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
    for (const row of result.rows) {
      const removed = row.outcome === 'removed';
      lines.push(
        [
          row.at,
          row.label ?? 'Anonymous',
          naira(row.gross),
          naira(row.fee),
          naira(row.net),
          row.status === 'SUCCEEDED' ? 'Paid' : 'Confirming',
          row.reference ? row.reference.slice(-6) : '',
          row.business && row.location
            ? `${row.business} · ${row.location}`
            : '',
          removed
            ? ''
            : (row.tags ?? [])
                .map((tag) => TAG_LABELS.get(tag) ?? tag)
                .join('; '),
          removed ? 'Removed by TipMe' : (row.body ?? ''),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return { csv: `${lines.join('\r\n')}\r\n`, rows: result.rows.length };
  });
}

const WORK_HEADER = [
  'Business',
  'Location',
  'Name shown',
  'Photo shown',
  'Amounts shared',
  'Joined (Lagos)',
  'Left (Lagos)',
  'Left by',
];

const LEFT_BY: Readonly<Record<string, string>> = {
  self: 'You',
  manager: 'A manager',
  account_deleted: 'Account deleted',
};

/**
 * Where a person's page has worked, as CSV (plan B9 Task 24): every membership, left ones
 * included, newest first, with what the person chose to show. Dates only, in Lagos.
 */
export function exportMyWorkCsv(
  db: Database,
  profileId: string,
): Promise<{ csv: string; rows: number }> {
  return guarded(async () => {
    const result = await db.execute<{
      business: string;
      location: string;
      shown_name: string;
      show_photo: boolean;
      share_amounts: boolean;
      joined: string;
      left: string | null;
      left_by: string | null;
    }>(sql`
      SELECT b.name AS business, l.name AS location, m.shown_name, m.show_photo, m.share_amounts,
             to_char(m.joined_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS joined,
             to_char(m.left_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS left,
             m.left_by
        FROM business_members m
        JOIN business_locations l ON l.id = m.location_id
        JOIN businesses b ON b.id = l.business_id
       WHERE m.profile_id = ${profileId}
       ORDER BY m.joined_at DESC, m.id DESC
       LIMIT ${EXPORT_LIMIT}`);
    const yes = (value: boolean) => (value ? 'Yes' : 'No');
    const lines = [WORK_HEADER.map(csvCell).join(',')];
    for (const row of result.rows)
      lines.push(
        [
          row.business,
          row.location,
          row.shown_name,
          yes(row.show_photo),
          yes(row.share_amounts),
          row.joined,
          row.left ?? '',
          row.left_by ? (LEFT_BY[row.left_by] ?? '') : '',
        ]
          .map(csvCell)
          .join(','),
      );
    return { csv: `${lines.join('\r\n')}\r\n`, rows: result.rows.length };
  });
}
