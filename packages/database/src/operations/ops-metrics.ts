import type { OpsHealth, OpsVisibility } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';

const ZONE = 'Africa/Lagos';
const SHARING_EVENTS = [
  'qr_scanned',
  'qr_downloaded',
  'qr_printed',
  'recipient_shared_link',
  'report_shared',
  'moment_shared',
] as const;

type Row = Record<string, unknown>;
const int = (value: unknown) => Number(value ?? 0);
const money = (value: unknown) => String(value ?? '0');
const rateOf = (failed: unknown, total: unknown) =>
  int(total) === 0
    ? null
    : Math.round((int(failed) / int(total)) * 1000) / 1000;
const secondsOf = (value: unknown) =>
  value === null || value === undefined ? null : Math.round(Number(value));

/** Admin health: this week (Monday 00:00 Lagos to now) against last week, from the money tables. */
export function healthMetrics(
  db: Database,
  input: { now: Date },
): Promise<OpsHealth> {
  return guarded(async () => {
    const one = async (query: ReturnType<typeof sql>): Promise<Row> =>
      ((await db.execute(query)).rows[0] ?? {}) as Row;
    const weeks = await one(sql`
      SELECT (date_trunc('week', ${input.now}::timestamptz AT TIME ZONE ${ZONE}) AT TIME ZONE ${ZONE}) AS this_start,
             (date_trunc('week', ${input.now}::timestamptz AT TIME ZONE ${ZONE}) AT TIME ZONE ${ZONE}) - interval '7 days' AS last_start`);
    // Raw queries return timestamps as text.
    const thisStart = new Date(String(weeks['this_start']));
    const lastStart = new Date(String(weeks['last_start']));
    const now = input.now;
    // Which week a timestamp falls in ('this', 'last' or null).
    const week = (column: ReturnType<typeof sql.raw>) => sql`CASE
      WHEN ${column} >= ${thisStart} AND ${column} <= ${now} THEN 'this'
      WHEN ${column} >= ${lastStart} AND ${column} < ${thisStart} THEN 'last' END`;

    const paid = await one(sql`
      WITH t AS (
        SELECT ${week(sql.raw('t.completed_at'))} AS wk, t.profile_id, t.gross_minor, t.created_at, t.completed_at,
               q.platform_fee_minor, q.waived_platform_fee_minor
          FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
         WHERE t.status = 'SUCCEEDED')
      SELECT count(*) FILTER (WHERE wk = 'this')::int AS count_this,
             count(*) FILTER (WHERE wk = 'last')::int AS count_last,
             coalesce(sum(gross_minor) FILTER (WHERE wk = 'this'), 0)::text AS gross_this,
             coalesce(sum(gross_minor) FILTER (WHERE wk = 'last'), 0)::text AS gross_last,
             coalesce(sum(platform_fee_minor) FILTER (WHERE wk = 'this'), 0)::text AS fee_this,
             coalesce(sum(platform_fee_minor) FILTER (WHERE wk = 'last'), 0)::text AS fee_last,
             coalesce(sum(waived_platform_fee_minor) FILTER (WHERE wk = 'this'), 0) AS waived_this,
             coalesce(sum(waived_platform_fee_minor) FILTER (WHERE wk = 'last'), 0) AS waived_last,
             count(DISTINCT profile_id) FILTER (WHERE wk = 'this')::int AS tipped_this,
             count(DISTINCT profile_id) FILTER (WHERE wk = 'last')::int AS tipped_last,
             (SELECT count(*)::int FROM (
                SELECT profile_id FROM t GROUP BY profile_id
                HAVING bool_or(wk = 'this') AND bool_or(wk = 'last')) both_weeks) AS returning,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at))
               FILTER (WHERE wk = 'this') AS median_this,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at))
               FILTER (WHERE wk = 'last') AS median_last
        FROM t`);
    const cash = await one(sql`
      SELECT coalesce(sum(cash_minor) FILTER (WHERE ${week(sql.raw('created_at'))} = 'this'), 0) AS this,
             coalesce(sum(cash_minor) FILTER (WHERE ${week(sql.raw('created_at'))} = 'last'), 0) AS last
        FROM reward_grants`);
    const started = await one(sql`
      WITH t AS (SELECT ${week(sql.raw('created_at'))} AS wk, status FROM tips
                  WHERE status IN ('SUCCEEDED', 'FAILED'))
      SELECT count(*) FILTER (WHERE wk = 'this' AND status = 'FAILED') AS failed_this,
             count(*) FILTER (WHERE wk = 'this') AS total_this,
             count(*) FILTER (WHERE wk = 'last' AND status = 'FAILED') AS failed_last,
             count(*) FILTER (WHERE wk = 'last') AS total_last
        FROM t`);
    const stuck = await one(sql`
      SELECT count(*)::int AS n FROM tips t
       WHERE t.created_at < ${new Date(now.getTime() - 30 * 60_000)}
         AND (t.status = 'PENDING_VERIFICATION'
              OR (t.status = 'AWAITING_PAYMENT' AND EXISTS (
                    SELECT 1 FROM payment_attempts a WHERE a.intent_id = t.intent_id AND a.status = 'PENDING')))`);
    const open = await one(sql`
      SELECT count(*) FILTER (WHERE severity = 'money')::int AS money,
             count(*) FILTER (WHERE severity = 'account')::int AS account,
             count(*) FILTER (WHERE severity = 'info')::int AS info
        FROM issues WHERE status = 'open'`);
    const people = await one(sql`
      SELECT (SELECT count(*) FROM users WHERE ${week(sql.raw('created_at'))} = 'this')::int AS signups_this,
             (SELECT count(*) FROM users WHERE ${week(sql.raw('created_at'))} = 'last')::int AS signups_last,
             (SELECT count(*) FROM profiles WHERE user_id IS NOT NULL AND ${week(sql.raw('created_at'))} = 'this')::int AS pages_this,
             (SELECT count(*) FROM profiles WHERE user_id IS NOT NULL AND ${week(sql.raw('created_at'))} = 'last')::int AS pages_last,
             (SELECT count(*) FROM profiles WHERE page_state = 'live' AND status = 'active')::int AS live`);
    const funnel = await one(sql`
      WITH e AS (SELECT * FROM analytics_events WHERE at_minute >= ${thisStart} AND at_minute <= ${now})
      SELECT (SELECT count(*) FROM (SELECT DISTINCT flow_id, handle FROM e
                WHERE name = 'profile_viewed' AND flow_id IS NOT NULL) v)::int AS visits,
             (SELECT count(DISTINCT flow_id) FROM e WHERE name = 'amount_selected')::int AS amount,
             (SELECT count(DISTINCT flow_id) FROM e WHERE name = 'payment_started')::int AS started,
             (SELECT count(*) FROM e WHERE name = 'tip_completed')::int AS completed`);

    return {
      weekStarts: {
        thisWeek: thisStart.toISOString(),
        lastWeek: lastStart.toISOString(),
      },
      money: {
        currency: 'NGN',
        tipCount: {
          thisWeek: int(paid['count_this']),
          lastWeek: int(paid['count_last']),
        },
        grossMinor: {
          thisWeek: money(paid['gross_this']),
          lastWeek: money(paid['gross_last']),
        },
        platformFeeMinor: {
          thisWeek: money(paid['fee_this']),
          lastWeek: money(paid['fee_last']),
        },
        rewardCostMinor: {
          thisWeek: (
            BigInt(money(paid['waived_this'])) + BigInt(money(cash['this']))
          ).toString(),
          lastWeek: (
            BigInt(money(paid['waived_last'])) + BigInt(money(cash['last']))
          ).toString(),
        },
      },
      reliability: {
        declinedRate: {
          thisWeek: rateOf(started['failed_this'], started['total_this']),
          lastWeek: rateOf(started['failed_last'], started['total_last']),
        },
        medianConfirmSeconds: {
          thisWeek: secondsOf(paid['median_this']),
          lastWeek: secondsOf(paid['median_last']),
        },
        stuckNow: int(stuck['n']),
        openIssues: {
          money: int(open['money']),
          account: int(open['account']),
          info: int(open['info']),
        },
      },
      recipients: {
        newSignups: {
          thisWeek: int(people['signups_this']),
          lastWeek: int(people['signups_last']),
        },
        newPages: {
          thisWeek: int(people['pages_this']),
          lastWeek: int(people['pages_last']),
        },
        livePages: int(people['live']),
        recipientsTipped: {
          thisWeek: int(paid['tipped_this']),
          lastWeek: int(paid['tipped_last']),
        },
        recipientsReturning: int(paid['returning']),
      },
      funnel: {
        visits: int(funnel['visits']),
        amountSelected: int(funnel['amount']),
        paymentStarted: int(funnel['started']),
        tipsCompleted: int(funnel['completed']),
      },
    };
  });
}

/**
 * Visibility over the last `days` Lagos days, from raw events (kept 90 days). A visit is one page
 * visit flow on one page; its channel is how its first view arrived, so channels add up to visits.
 */
export function visibilityMetrics(
  db: Database,
  input: { now: Date; days?: number },
): Promise<OpsVisibility> {
  const days = Math.min(Math.max(input.days ?? 28, 1), 90);
  return guarded(async () => {
    const range = (
      await db.execute<{ from: string; to: string }>(sql`
        SELECT to_char((${input.now}::timestamptz AT TIME ZONE ${ZONE})::date - ${days - 1}::int, 'YYYY-MM-DD') AS "from",
               to_char((${input.now}::timestamptz AT TIME ZONE ${ZONE})::date, 'YYYY-MM-DD') AS "to"`)
    ).rows[0]!;
    const visitsCte = sql`
      WITH e AS (
        SELECT *, (at_minute AT TIME ZONE ${ZONE})::date AS day FROM analytics_events
         WHERE (at_minute AT TIME ZONE ${ZONE})::date BETWEEN ${range.from}::date AND ${range.to}::date),
      v AS (
        SELECT DISTINCT ON (flow_id, coalesce(handle, ''))
               flow_id, handle, day, coalesce(channel, 'other') AS channel, coalesce("returning", false) AS is_returning
          FROM e WHERE name = 'profile_viewed' AND flow_id IS NOT NULL
         ORDER BY flow_id, coalesce(handle, ''), at_minute, id)`;
    const perDay = await db.execute<{
      date: string;
      visits: number;
      returning: number;
    }>(sql`
      ${visitsCte}
      SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
             (SELECT count(*) FROM v WHERE v.day = d::date)::int AS visits,
             (SELECT count(*) FROM v WHERE v.day = d::date AND v.is_returning)::int AS returning
        FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d
       ORDER BY d`);
    const channels = await db.execute<{ channel: string; visits: number }>(sql`
      ${visitsCte}
      SELECT channel, count(*)::int AS visits FROM v GROUP BY channel ORDER BY visits DESC, channel`);
    const top = await db.execute<{ handle: string; visits: number }>(sql`
      ${visitsCte}
      SELECT handle, count(*)::int AS visits FROM v WHERE handle IS NOT NULL
       GROUP BY handle ORDER BY visits DESC, handle LIMIT 10`);
    const shares = await db.execute<{ name: string; n: number }>(sql`
      ${visitsCte}
      SELECT name, count(*)::int AS n FROM e
       WHERE name IN (${sql.join(
         SHARING_EVENTS.map((n) => sql`${n}`),
         sql`, `,
       )})
       GROUP BY name`);
    const celebrations = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tips
       WHERE status = 'SUCCEEDED' AND celebration_moment_id IS NOT NULL
         AND (completed_at AT TIME ZONE ${ZONE})::date BETWEEN ${range.from}::date AND ${range.to}::date`);

    const visitsPerDay = perDay.rows.map((row) => ({
      date: row.date,
      visits: int(row.visits),
      returning: int(row.returning),
    }));
    const sharing: Record<string, number> = Object.fromEntries(
      SHARING_EVENTS.map((name) => [name, 0]),
    );
    for (const row of shares.rows) sharing[row.name] = int(row.n);
    return {
      days,
      from: range.from,
      to: range.to,
      visits: visitsPerDay.reduce((sum, d) => sum + d.visits, 0),
      returningVisits: visitsPerDay.reduce((sum, d) => sum + d.returning, 0),
      visitsPerDay,
      byChannel: channels.rows.map((row) => ({
        channel: row.channel,
        visits: int(row.visits),
      })),
      sharing,
      celebrationTips: int(celebrations.rows[0]?.n),
      topPages: top.rows.map((row) => ({
        handle: row.handle,
        visits: int(row.visits),
      })),
    };
  });
}
