import type { WeeklyReportData } from '@tipme/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { notifications, profiles, users, weeklyReports } from '../schema.js';
import { guarded } from './errors.js';
import { maskEmail } from './email.js';
import { newId } from './ids.js';
import { writePretendMessage } from './pretend-outbox.js';

const ZONE = 'Africa/Lagos';
const DAY_MS = 86_400_000;

/** The civil date in Lagos, as UTC midnight of that date. */
function lagosDate(date: Date): Date {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .split('-')
    .map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** ISO 8601 week ("2026-W41") of a moment, in Lagos time. */
export function isoWeekOf(date: Date): string {
  const day = lagosDate(date);
  const weekday = day.getUTCDay() || 7;
  const thursday = new Date(day.getTime() + (4 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(
    ((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The ISO week that ended most recently before `now` (what Monday's report covers). */
export const previousIsoWeek = (now: Date): string =>
  isoWeekOf(new Date(now.getTime() - 7 * DAY_MS));

/** Monday of an ISO week, as YYYY-MM-DD. */
export function mondayOf(isoWeek: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new RangeError('not an ISO week');
  const year = Number(match[1]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS;
  return new Date(week1Monday + (Number(match[2]) - 1) * 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

const netOfDay = sql`(t.completed_at AT TIME ZONE ${ZONE})::date`;

export function buildWeeklyReport(
  db: Database,
  profileId: string,
  isoWeek: string,
): Promise<WeeklyReportData> {
  const monday = mondayOf(isoWeek);
  return guarded(async () => {
    const totals = await db.execute<{
      total: string;
      tips: number;
      notes: number;
      previous: string;
    }>(sql`
      WITH paid AS (
        SELECT t.id, ${netOfDay} AS day, q.recipient_net_minor AS net
          FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
         WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED' AND t.completed_at IS NOT NULL)
      SELECT
        COALESCE(SUM(net) FILTER (WHERE day BETWEEN ${monday}::date AND ${monday}::date + 6), 0)::text AS total,
        COUNT(*) FILTER (WHERE day BETWEEN ${monday}::date AND ${monday}::date + 6)::int AS tips,
        COUNT(*) FILTER (WHERE day BETWEEN ${monday}::date AND ${monday}::date + 6
                           AND EXISTS (SELECT 1 FROM tip_messages m WHERE m.tip_id = paid.id))::int AS notes,
        COALESCE(SUM(net) FILTER (WHERE day BETWEEN ${monday}::date - 7 AND ${monday}::date - 1), 0)::text AS previous
        FROM paid`);
    const best = await db.execute<{ date: string; net: string }>(sql`
      SELECT to_char(${netOfDay}, 'YYYY-MM-DD') AS date, SUM(q.recipient_net_minor)::text AS net
        FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
       WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED'
         AND ${netOfDay} BETWEEN ${monday}::date AND ${monday}::date + 6
       GROUP BY 1 ORDER BY SUM(q.recipient_net_minor) DESC, 1 DESC LIMIT 1`);
    const top = await db.execute<{ label: string }>(sql`
      SELECT t.payer_display_label AS label
        FROM tips t
       WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED' AND t.payer_display_label IS NOT NULL
         AND ${netOfDay} BETWEEN ${monday}::date AND ${monday}::date + 6
       GROUP BY t.payer_display_label
       ORDER BY COUNT(*) DESC, MAX(t.completed_at) DESC LIMIT 1`);
    const celebrated = await db.execute<{ key: string; title: string }>(sql`
      SELECT key, title FROM moments
       WHERE profile_id = ${profileId}
         AND ((created_at AT TIME ZONE ${ZONE})::date BETWEEN ${monday}::date AND ${monday}::date + 6
              OR key = ${`best_week.${isoWeek}.${profileId}`})
       ORDER BY created_at`);
    const row = totals.rows[0];
    const total = BigInt(row?.total ?? '0');
    const previous = BigInt(row?.previous ?? '0');
    const bestRow = best.rows[0];
    return {
      week: isoWeek,
      totalNetMinor: total.toString(),
      changePct:
        previous === 0n
          ? null
          : Math.round((Number(total - previous) / Number(previous)) * 100),
      tipCount: row?.tips ?? 0,
      notesCount: row?.notes ?? 0,
      bestDay: bestRow ? { date: bestRow.date, netMinor: bestRow.net } : null,
      topSupporterLabel: top.rows[0]?.label ?? null,
      moments: celebrated.rows.map((moment) => ({
        key: moment.key,
        title: moment.title,
      })),
    };
  });
}

const ngn = (minor: bigint) =>
  `NGN ${new Intl.NumberFormat('en').format(Number(minor / 100n))}.${String(minor % 100n).padStart(2, '0')}`;

/**
 * Creates the week's report for every recipient who was tipped that week (a "nothing this week"
 * report would only nudge), with a notification and, for a verified email, a pretend email.
 * Each report exists once per recipient and week, however often this runs.
 */
export function runWeeklyReports(
  db: Database,
  input: { isoWeek: string; onlyHandle?: string },
): Promise<{ created: number }> {
  const monday = mondayOf(input.isoWeek);
  return guarded(async () => {
    const tipped = await db.execute<{ profile_id: string }>(sql`
      SELECT DISTINCT t.profile_id FROM tips t JOIN profiles p ON p.id = t.profile_id
       WHERE t.status = 'SUCCEEDED' AND p.page_state <> 'deleted'
         ${input.onlyHandle ? sql`AND p.handle_lower = ${input.onlyHandle.toLowerCase()}` : sql``}
         AND ${netOfDay} BETWEEN ${monday}::date AND ${monday}::date + 6`);
    let created = 0;
    for (const { profile_id: profileId } of tipped.rows) {
      const data = await buildWeeklyReport(db, profileId, input.isoWeek);
      const made = await db.transaction(async (tx) => {
        const reportId = newId();
        const inserted = await tx
          .insert(weeklyReports)
          .values({ id: reportId, profileId, isoWeek: input.isoWeek, data })
          .onConflictDoNothing()
          .returning({ id: weeklyReports.id });
        if (!inserted[0]) return false;
        const [owner] = await tx
          .select({
            userId: profiles.userId,
            email: users.email,
            verified: users.emailVerifiedAt,
          })
          .from(profiles)
          .leftJoin(users, eq(users.id, profiles.userId))
          .where(eq(profiles.id, profileId));
        if (!owner?.userId) return true;
        const body = `${ngn(BigInt(data.totalNetMinor))} from ${data.tipCount} ${data.tipCount === 1 ? 'tip' : 'tips'}`;
        await tx.insert(notifications).values({
          id: newId(),
          userId: owner.userId,
          kind: 'weekly_report',
          reportId,
          title: 'Your week on TipMe',
          body,
        });
        if (owner.email && owner.verified)
          await writePretendMessage(tx, {
            channel: 'email',
            recipientHint: maskEmail(owner.email),
            userId: owner.userId,
            subject: 'Your week on TipMe',
            body: `Your week (${input.isoWeek}): ${body}. Open your dashboard to see the whole week.`,
          });
        return true;
      });
      if (made) created += 1;
    }
    return { created };
  });
}

export function listWeeklyReports(
  db: Database,
  profileId: string,
): Promise<{ week: string; data: WeeklyReportData }[]> {
  return guarded(async () =>
    (
      await db
        .select({ week: weeklyReports.isoWeek, data: weeklyReports.data })
        .from(weeklyReports)
        .where(eq(weeklyReports.profileId, profileId))
        .orderBy(desc(weeklyReports.isoWeek))
        .limit(52)
    ).map((row) => ({ week: row.week, data: row.data as WeeklyReportData })),
  );
}

export function getWeeklyReport(
  db: Database,
  profileId: string,
  isoWeek: string,
): Promise<WeeklyReportData | null> {
  if (!/^\d{4}-W\d{2}$/.test(isoWeek)) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select({ data: weeklyReports.data })
      .from(weeklyReports)
      .where(
        and(
          eq(weeklyReports.profileId, profileId),
          eq(weeklyReports.isoWeek, isoWeek),
        ),
      );
    return (row?.data as WeeklyReportData | undefined) ?? null;
  });
}
