import type {
  ActivityRow,
  DashboardSummary,
  MyTipDetail,
  MyTipRow,
  TipState,
} from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { balanceIn } from './balance.js';
import { guarded } from './errors.js';
import { tipProof } from './proof.js';

/** Day, week (ISO, Monday) and month boundaries follow Lagos time while D-01 is open. */
export const DASHBOARD_TIME_ZONE = 'Africa/Lagos';

/** The recipient's numbers: net amounts of confirmed tips by when they were confirmed. */
export function dashboardSummary(
  db: Database,
  profileId: string,
  now: Date,
): Promise<DashboardSummary> {
  return guarded(async () => {
    const at = now.toISOString();
    const totals = await db.execute<{
      today: string;
      yesterday: string;
      this_week: string;
      last_week: string;
    }>(sql`
      WITH local AS (SELECT (${at}::timestamptz AT TIME ZONE ${DASHBOARD_TIME_ZONE})::date AS today),
      paid AS (
        SELECT (t.completed_at AT TIME ZONE ${DASHBOARD_TIME_ZONE})::date AS day, q.recipient_net_minor AS net
          FROM tips t
          JOIN payment_intents i ON i.id = t.intent_id
          JOIN tip_quotes q ON q.id = i.quote_id
         WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED' AND t.completed_at IS NOT NULL)
      SELECT
        COALESCE(SUM(net) FILTER (WHERE day = today), 0)::text AS today,
        COALESCE(SUM(net) FILTER (WHERE day = today - 1), 0)::text AS yesterday,
        COALESCE(SUM(net) FILTER (WHERE day >= date_trunc('week', today)::date AND day <= today), 0)::text AS this_week,
        COALESCE(SUM(net) FILTER (WHERE day >= date_trunc('week', today)::date - 7
                                    AND day < date_trunc('week', today)::date), 0)::text AS last_week
        FROM local LEFT JOIN paid ON true
       GROUP BY today`);
    const days = await db.execute<{ date: string; net: string }>(sql`
      WITH local AS (SELECT (${at}::timestamptz AT TIME ZONE ${DASHBOARD_TIME_ZONE})::date AS today)
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
             COALESCE(SUM(q.recipient_net_minor), 0)::text AS net
        FROM local,
             generate_series(local.today - 6, local.today, interval '1 day') AS d(day)
        LEFT JOIN tips t
          ON t.profile_id = ${profileId} AND t.status = 'SUCCEEDED'
         AND (t.completed_at AT TIME ZONE ${DASHBOARD_TIME_ZONE})::date = d.day::date
        LEFT JOIN payment_intents i ON i.id = t.intent_id
        LEFT JOIN tip_quotes q ON q.id = i.quote_id
       GROUP BY d.day ORDER BY d.day`);
    const balance = await balanceIn(db, profileId);
    const row = totals.rows[0];
    return {
      currency: 'NGN',
      availableMinor: balance.availableMinor.toString(),
      confirmingMinor: balance.confirmingMinor.toString(),
      today: row?.today ?? '0',
      yesterday: row?.yesterday ?? '0',
      thisWeek: row?.this_week ?? '0',
      lastWeek: row?.last_week ?? '0',
      last7Days: days.rows.map((day) => ({
        date: day.date,
        netMinor: day.net,
      })),
    };
  });
}

/**
 * Tips a recipient sees: paid, or really being confirmed by the provider (the same rule as the
 * "confirming" balance). A checkout that was opened but never paid is not a tip.
 */
const visibleTip = sql`(t.status IN ('SUCCEEDED', 'PENDING_VERIFICATION')
  OR (t.status = 'AWAITING_PAYMENT' AND EXISTS (
        SELECT 1 FROM payment_attempts pa WHERE pa.intent_id = t.intent_id AND pa.status = 'PENDING')))`;
const stateSql = sql`CASE t.status WHEN 'SUCCEEDED' THEN 'paid' WHEN 'FAILED' THEN 'failed'
  WHEN 'CANCELLED' THEN 'cancelled' ELSE 'confirming' END`;

const encodeCursor = (at: string, id: string) =>
  Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(
  cursor: string | undefined,
): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return at && id && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/.test(id)
    ? { at, id }
    : null;
}

/** The recipient's tips, newest first (by confirmation, or creation while unconfirmed). */
export function listMyTips(
  db: Database,
  profileId: string,
  input: {
    cursor?: string;
    status?: 'paid' | 'confirming' | 'all';
    limit?: number;
  },
): Promise<{ items: MyTipRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const after = decodeCursor(input.cursor);
  const status = input.status ?? 'all';
  return guarded(async () => {
    const rows = await db.execute<{
      tip_id: string;
      at: string;
      label: string | null;
      has_message: boolean;
      gross: string;
      net: string;
      state: TipState;
    }>(sql`
      SELECT t.id AS tip_id, to_char(COALESCE(t.completed_at, t.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
             t.payer_display_label AS label,
             EXISTS (SELECT 1 FROM tip_messages m WHERE m.tip_id = t.id) AS has_message,
             t.gross_minor::text AS gross, q.recipient_net_minor::text AS net, ${stateSql} AS state
        FROM tips t
        JOIN payment_intents i ON i.id = t.intent_id
        JOIN tip_quotes q ON q.id = i.quote_id
       WHERE t.profile_id = ${profileId}
         AND ${visibleTip}
         ${status === 'paid' ? sql`AND t.status = 'SUCCEEDED'` : status === 'confirming' ? sql`AND t.status <> 'SUCCEEDED'` : sql``}
         ${after ? sql`AND (COALESCE(t.completed_at, t.created_at), t.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
       ORDER BY COALESCE(t.completed_at, t.created_at) DESC, t.id DESC
       LIMIT ${limit + 1}`);
    const items = rows.rows.slice(0, limit).map((row) => ({
      tipId: row.tip_id,
      at: row.at,
      supporterLabel: row.label,
      hasMessage: row.has_message,
      grossMinor: row.gross,
      netMinor: row.net,
      state: row.state,
    }));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.rows.length > limit && last
          ? encodeCursor(last.at, last.tipId)
          : null,
    };
  });
}

/** One of the recipient's own tips with its proof; null for anyone else's tip. */
export function myTipDetail(
  db: Database,
  profileId: string,
  tipId: string,
): Promise<MyTipDetail | null> {
  if (!/^[0-9a-f-]{36}$/.test(tipId)) return Promise.resolve(null);
  return guarded(async () => {
    const rows = await db.execute<{
      state: TipState;
      at: string;
      label: string | null;
      message: string | null;
      currency: string;
      gross: string;
      platform: string;
      provider_fee: string;
      net: string;
      policy: string;
      provider: string | null;
    }>(sql`
      SELECT ${stateSql} AS state,
             to_char(COALESCE(t.completed_at, t.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
             t.payer_display_label AS label, m.body AS message, t.currency,
             t.gross_minor::text AS gross, q.platform_fee_minor::text AS platform,
             q.provider_fee_minor::text AS provider_fee, q.recipient_net_minor::text AS net,
             q.fee_policy_version AS policy,
             (SELECT a.provider FROM payment_attempts a WHERE a.intent_id = t.intent_id
               ORDER BY a.attempt_number DESC LIMIT 1) AS provider
        FROM tips t
        JOIN payment_intents i ON i.id = t.intent_id
        JOIN tip_quotes q ON q.id = i.quote_id
        LEFT JOIN tip_messages m ON m.tip_id = t.id
       WHERE t.id = ${tipId} AND t.profile_id = ${profileId} AND ${visibleTip}`);
    const row = rows.rows[0];
    if (!row) return null;
    const proof = await tipProof(db, tipId);
    const reference = proof?.payment?.providerReference ?? null;
    return {
      tipId,
      state: row.state,
      at: row.at,
      // A supporter's name and words reach the recipient only with a paid tip.
      supporterLabel: row.state === 'paid' ? row.label : null,
      message: row.state === 'paid' ? row.message : null,
      currency: row.currency,
      grossMinor: row.gross,
      platformFeeMinor: row.platform,
      providerFeeMinor: row.provider_fee,
      netMinor: row.net,
      feePolicyVersion: row.policy,
      proof: {
        verified:
          row.state === 'paid' &&
          proof?.payment !== null &&
          proof?.payment !== undefined,
        provider: row.provider,
        // Only the end of the provider's reference: enough to match a statement, never the whole.
        referenceTail: reference ? reference.slice(-6) : null,
        verifiedAt: proof?.payment?.verifiedAt ?? null,
        ledgerTransactionId: proof?.paymentLedgerTransactionId ?? null,
      },
    };
  });
}

/** Tips and withdrawals together, newest first. */
export function recentActivity(
  db: Database,
  profileId: string,
  limit = 10,
): Promise<ActivityRow[]> {
  return guarded(async () => {
    const rows = await db.execute<{
      kind: 'tip' | 'withdrawal';
      id: string;
      at: string;
      amount: string;
      state: string;
      label: string | null;
    }>(sql`
      SELECT * FROM (
        SELECT 'tip' AS kind, t.id, COALESCE(t.completed_at, t.created_at) AS sort_at,
               to_char(COALESCE(t.completed_at, t.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
               q.recipient_net_minor::text AS amount, ${stateSql} AS state, t.payer_display_label AS label
          FROM tips t
          JOIN payment_intents i ON i.id = t.intent_id
          JOIN tip_quotes q ON q.id = i.quote_id
         WHERE t.profile_id = ${profileId} AND t.status IN ('SUCCEEDED', 'PENDING_VERIFICATION')
        UNION ALL
        SELECT 'withdrawal', p.id, COALESCE(p.paid_at, p.created_at),
               to_char(COALESCE(p.paid_at, p.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               p.amount_minor::text,
               CASE p.status WHEN 'PAID' THEN 'sent' WHEN 'FAILED' THEN 'failed'
                 WHEN 'PROCESSING' THEN 'processing' WHEN 'REVERSED' THEN 'reversed' ELSE 'requested' END,
               NULL
          FROM payouts p WHERE p.profile_id = ${profileId}
      ) activity
      ORDER BY sort_at DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}`);
    return rows.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      at: row.at,
      amountMinor: row.amount,
      state: row.state,
      supporterLabel: row.label,
    }));
  });
}
