import type {
  EarningsPeriod,
  EarningsPeriodView,
  EarningsSummary,
  EarningsTotal,
  EarningsTrend,
} from '@tipme/contracts';
import {
  averageTipMinor,
  bestWeekday,
  earningsNotes,
  earningsWindow,
} from '@tipme/domain';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';

// Earnings analytics (Pro, ProEarnings board). Only confirmed tips, at each tip's net (after
// the TipMe fee each tip recorded), on the Lagos day it was confirmed. Every amount is a bigint sum in kobo.

const ZONE = 'Africa/Lagos';

/** The Lagos civil date of a moment, YYYY-MM-DD. */
export function lagosDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Paid tips of one page with their Lagos day and net, for the CTEs below. */
const paidOf = (profileId: string, from: string, to: string) => sql`
  SELECT t.id, (t.completed_at AT TIME ZONE ${ZONE})::date AS day, q.recipient_net_minor AS net
    FROM tips t
    JOIN payment_intents i ON i.id = t.intent_id
    JOIN tip_quotes q ON q.id = i.quote_id
   WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED' AND t.completed_at IS NOT NULL
     AND t.completed_at >= (${from}::date::timestamp AT TIME ZONE ${ZONE})
     AND t.completed_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${ZONE})`;

async function totalBetween(
  db: Database,
  profileId: string,
  from: string,
  to: string,
): Promise<EarningsTotal> {
  const rows = await db.execute<{ net: string; tips: number }>(sql`
    WITH paid AS (${paidOf(profileId, from, to)})
    SELECT COALESCE(SUM(net), 0)::text AS net, COUNT(*)::int AS tips FROM paid`);
  return { netMinor: rows.rows[0]?.net ?? '0', tips: rows.rows[0]?.tips ?? 0 };
}

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** The basics everyone sees: this week, this month, this year and all time. */
export function earningsSummary(
  db: Database,
  profileId: string,
  now: Date,
): Promise<EarningsSummary> {
  const today = lagosDay(now);
  const week = earningsWindow('week', today, today);
  const month = earningsWindow('month', today, today);
  if (!week || !month) throw new RangeError('bad date');
  const yearFrom = `${today.slice(0, 4)}-01-01`;
  return guarded(async () => {
    const [thisWeek, lastWeek, thisMonth, lastMonth, thisYear, allTime] =
      await Promise.all([
        totalBetween(db, profileId, week.from, week.to),
        totalBetween(db, profileId, week.previous.from, week.previous.to),
        totalBetween(db, profileId, month.from, month.to),
        totalBetween(db, profileId, month.previous.from, month.previous.to),
        totalBetween(db, profileId, yearFrom, today),
        totalBetween(db, profileId, '2000-01-01', today),
      ]);
    const joined = await db.execute<{ day: string }>(sql`
      SELECT to_char((created_at AT TIME ZONE ${ZONE})::date, 'YYYY-MM-DD') AS day
        FROM profiles WHERE id = ${profileId}`);
    return {
      currency: 'NGN',
      today,
      thisWeek: { ...thisWeek, previous: lastWeek },
      thisMonth: { ...thisMonth, from: month.from, previous: lastMonth },
      thisYear: { ...thisYear, from: yearFrom },
      allTime,
      joinedOn: joined.rows[0]?.day ?? today,
    };
  });
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** How the previous period reads after an amount in a note. */
function previousLabel(
  period: EarningsPeriod,
  complete: boolean,
  previousFrom: string,
): string {
  const year = previousFrom.slice(0, 4);
  const month = MONTHS[Number(previousFrom.slice(5, 7)) - 1] ?? '';
  if (period === 'week')
    return complete ? 'the week before' : 'on the same days the week before';
  if (period === 'month')
    return complete ? `in ${month}` : `on the same days of ${month}`;
  return complete ? `in ${year}` : `on the same days of ${year}`;
}

/** One week, month or year (Pro); null for a malformed date or one after today. */
export function earningsPeriod(
  db: Database,
  profileId: string,
  input: { period: EarningsPeriod; at?: string; now: Date },
): Promise<EarningsPeriodView | null> {
  const today = lagosDay(input.now);
  const window = earningsWindow(input.period, input.at ?? today, today);
  if (!window) return Promise.resolve(null);
  return guarded(async () => {
    const [current, previous] = await Promise.all([
      totalBetween(db, profileId, window.from, window.to),
      totalBetween(db, profileId, window.previous.from, window.previous.to),
    ]);
    const weekdays = await db.execute<{ dow: number; tips: number }>(sql`
      WITH paid AS (${paidOf(profileId, window.from, window.to)})
      SELECT (EXTRACT(ISODOW FROM day)::int - 1) AS dow, COUNT(*)::int AS tips
        FROM paid GROUP BY 1`);
    const byWeekday = [0, 0, 0, 0, 0, 0, 0];
    for (const row of weekdays.rows) byWeekday[row.dow] = row.tips;
    // Opted-in supporters only (tip_supporters exists only for a ticked box); never a name.
    const repeat = await db.execute<{ n: number }>(sql`
      WITH paid AS (${paidOf(profileId, window.from, window.to)})
      SELECT COUNT(*)::int AS n FROM (
        SELECT ts.supporter_id FROM paid JOIN tip_supporters ts ON ts.tip_id = paid.id
         GROUP BY ts.supporter_id HAVING COUNT(*) >= 2) r`);
    const earlier = await db.execute<{ yes: boolean }>(sql`
      SELECT (created_at AT TIME ZONE ${ZONE})::date < ${window.from}::date AS yes
        FROM profiles WHERE id = ${profileId}`);
    const net = BigInt(current.netMinor);
    const previousNet = BigInt(previous.netMinor);
    const average = averageTipMinor(net, current.tips);
    const previousAverage = averageTipMinor(previousNet, previous.tips);
    const bestDay = bestWeekday(byWeekday, current.tips);
    const repeatSupporters = repeat.rows[0]?.n ?? 0;
    return {
      currency: 'NGN',
      period: input.period,
      from: window.from,
      to: window.to,
      complete: window.complete,
      netMinor: current.netMinor,
      tips: current.tips,
      averageMinor: average?.toString() ?? null,
      previous: {
        ...previous,
        from: window.previous.from,
        to: window.previous.to,
        averageMinor: previousAverage?.toString() ?? null,
      },
      changePct:
        previousNet === 0n
          ? null
          : Math.round((Number(net - previousNet) / Number(previousNet)) * 100),
      byWeekday,
      bestDay,
      repeatSupporters,
      notes: earningsNotes({
        tips: current.tips,
        averageMinor: average,
        previous: {
          tips: previous.tips,
          averageMinor: previousAverage,
          label: previousLabel(
            input.period,
            window.complete,
            window.previous.from,
          ),
        },
        best: bestDay,
        repeatSupporters,
      }),
      hasEarlier: earlier.rows[0]?.yes === true,
    };
  });
}

/** The last 12 weeks or months, oldest first; the last one is the current, still open. */
export function earningsTrend(
  db: Database,
  profileId: string,
  input: { unit: 'week' | 'month'; now: Date },
): Promise<EarningsTrend> {
  const today = lagosDay(input.now);
  const current = earningsWindow(input.unit, today, today);
  if (!current) throw new RangeError('bad date');
  const starts: string[] = [];
  if (input.unit === 'week')
    for (let back = 11; back >= 0; back--)
      starts.push(shift(current.from, -7 * back));
  else {
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7)) - 1;
    for (let back = 11; back >= 0; back--)
      starts.push(
        new Date(Date.UTC(y, m - back, 1)).toISOString().slice(0, 10),
      );
  }
  const first = starts[0] ?? current.from;
  const bucket: SQL =
    input.unit === 'week'
      ? sql`date_trunc('week', day)::date`
      : sql`date_trunc('month', day)::date`;
  return guarded(async () => {
    const rows = await db.execute<{ start: string; net: string; tips: number }>(
      sql`
      WITH paid AS (${paidOf(profileId, first, today)})
      SELECT to_char(${bucket}, 'YYYY-MM-DD') AS start, SUM(net)::text AS net, COUNT(*)::int AS tips
        FROM paid GROUP BY 1`,
    );
    const byStart = new Map(rows.rows.map((row) => [row.start, row]));
    return {
      currency: 'NGN',
      unit: input.unit,
      points: starts.map((from) => ({
        from,
        netMinor: byStart.get(from)?.net ?? '0',
        tips: byStart.get(from)?.tips ?? 0,
        complete: from !== current.from,
      })),
    };
  });
}

/** The signed-in person's page id and plan, for the Pro gates; null without a live-or-draft page. */
export function myPagePlan(
  db: Database,
  userId: string,
): Promise<{ profileId: string; pro: boolean } | null> {
  return guarded(async () => {
    const rows = await db.execute<{ id: string; plan: string }>(sql`
      SELECT id, plan FROM profiles WHERE user_id = ${userId} AND page_state <> 'deleted' LIMIT 1`);
    const row = rows.rows[0];
    return row ? { profileId: row.id, pro: row.plan === 'pro' } : null;
  });
}
