import {
  RECAP_MONTH_PATTERN,
  type MonthlyRecapData,
  type MonthlyRecapListItem,
} from '@tipme/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { monthlyRecaps, profiles, users } from '../schema.js';
import { earningsPeriod } from './earnings.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';

// Monthly recap (Pro; ProAdditions §5, approved 5 Nov 2026), built on the earnings analytics.

const ZONE = 'Africa/Lagos';

/** The Lagos month before `now`, YYYY-MM. */
export function previousLagosMonth(now: Date): string {
  const local = new Date(now.getTime() + 3_600_000);
  const back = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1),
  );
  return back.toISOString().slice(0, 7);
}

const lastDayOf = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);

/** A finished month's recap data: counts and the private total. Never a name or a message. */
export function buildMonthlyRecap(
  db: Database,
  profileId: string,
  month: string,
): Promise<MonthlyRecapData> {
  const from = `${month}-01`;
  const to = lastDayOf(month);
  return guarded(async () => {
    // "now" just after the month, so it reads as a whole, finished month.
    const period = await earningsPeriod(db, profileId, {
      period: 'month',
      at: from,
      now: new Date(`${to}T23:00:00Z`),
    });
    const weeks = await db.execute<{
      monday: string;
      tips: number;
      net: string;
    }>(sql`
      SELECT to_char(date_trunc('week', (t.completed_at AT TIME ZONE ${ZONE})::date), 'YYYY-MM-DD') AS monday,
             COUNT(*)::int AS tips, SUM(q.recipient_net_minor)::text AS net
        FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
       WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED'
         AND (t.completed_at AT TIME ZONE ${ZONE})::date BETWEEN ${from}::date AND ${to}::date
       GROUP BY 1
       ORDER BY COUNT(*) DESC, SUM(q.recipient_net_minor) DESC, 1 DESC LIMIT 1`);
    const notes = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM tips t
       WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED'
         AND (t.completed_at AT TIME ZONE ${ZONE})::date BETWEEN ${from}::date AND ${to}::date
         AND EXISTS (SELECT 1 FROM tip_messages m WHERE m.tip_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM message_flags f WHERE f.tip_id = t.id)`);
    const best = weeks.rows[0];
    const sunday = best
      ? new Date(Date.parse(`${best.monday}T00:00:00Z`) + 6 * 86_400_000)
          .toISOString()
          .slice(0, 10)
      : null;
    return {
      month,
      tipCount: period?.tips ?? 0,
      totalNetMinor: period?.netMinor ?? '0',
      averageMinor: period?.averageMinor ?? null,
      previousNetMinor: period?.previous.netMinor ?? '0',
      // Clipped to the month's own days.
      bestWeek:
        best && sunday
          ? {
              from: best.monday < from ? from : best.monday,
              to: sunday > to ? to : sunday,
              tips: best.tips,
            }
          : null,
      bestDay: period?.bestDay ?? null,
      notes: notes.rows[0]?.n ?? 0,
    };
  });
}

/**
 * Makes last month's recap for every Pro page tipped in it, once each however often this runs,
 * and, for a verified email with report emails on, queues the "recap ready" email.
 */
export function runMonthlyRecaps(
  db: Database,
  input: { sealing: MailSealing; month: string },
): Promise<{ created: number; profileIds: string[] }> {
  if (!RECAP_MONTH_PATTERN.test(input.month))
    return Promise.reject(new RangeError('month must be YYYY-MM'));
  const from = `${input.month}-01`;
  const to = lastDayOf(input.month);
  return guarded(async () => {
    const pages = await db.execute<{ profile_id: string }>(sql`
      SELECT DISTINCT t.profile_id FROM tips t JOIN profiles p ON p.id = t.profile_id
       WHERE t.status = 'SUCCEEDED' AND p.plan = 'pro' AND p.page_state <> 'deleted'
         AND (t.completed_at AT TIME ZONE ${ZONE})::date BETWEEN ${from}::date AND ${to}::date`);
    let created = 0;
    const profileIds: string[] = [];
    for (const { profile_id: profileId } of pages.rows) {
      const data = await buildMonthlyRecap(db, profileId, input.month);
      const made = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(monthlyRecaps)
          .values({ id: newId(), profileId, month: input.month, data })
          .onConflictDoNothing()
          .returning({ id: monthlyRecaps.id });
        if (!inserted[0]) return false;
        const [owner] = await tx
          .select({
            userId: profiles.userId,
            email: users.email,
            verified: users.emailVerifiedAt,
            wants: profiles.notifyWeeklyReports,
          })
          .from(profiles)
          .leftJoin(users, eq(users.id, profiles.userId))
          .where(eq(profiles.id, profileId));
        if (owner?.userId && owner.wants && owner.email && owner.verified)
          await enqueueMail(tx, input.sealing, {
            type: 'monthly_recap',
            to: owner.email,
            userId: owner.userId,
            data: { month: input.month, tipCount: data.tipCount },
            dedupeKey: `monthly_recap.${profileId}.${input.month}`,
          });
        return true;
      });
      if (made) {
        created += 1;
        profileIds.push(profileId);
      }
    }
    return { created, profileIds };
  });
}

export function listMonthlyRecaps(
  db: Database,
  profileId: string,
): Promise<MonthlyRecapListItem[]> {
  return guarded(async () =>
    (
      await db
        .select({
          month: monthlyRecaps.month,
          data: monthlyRecaps.data,
          createdAt: monthlyRecaps.createdAt,
        })
        .from(monthlyRecaps)
        .where(eq(monthlyRecaps.profileId, profileId))
        .orderBy(desc(monthlyRecaps.month))
        .limit(12)
    ).map((row) => ({
      month: row.month,
      tipCount: (row.data as MonthlyRecapData).tipCount,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

/** Field by field, so nothing an older row might carry is passed on. */
const pick = (data: MonthlyRecapData): MonthlyRecapData => ({
  month: data.month,
  tipCount: data.tipCount,
  totalNetMinor: data.totalNetMinor,
  averageMinor: data.averageMinor,
  previousNetMinor: data.previousNetMinor,
  bestWeek: data.bestWeek
    ? {
        from: data.bestWeek.from,
        to: data.bestWeek.to,
        tips: data.bestWeek.tips,
      }
    : null,
  bestDay: data.bestDay
    ? { weekday: data.bestDay.weekday, tips: data.bestDay.tips }
    : null,
  notes: data.notes,
});

export function getMonthlyRecap(
  db: Database,
  profileId: string,
  month: string,
): Promise<MonthlyRecapData | null> {
  if (!RECAP_MONTH_PATTERN.test(month)) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select({ data: monthlyRecaps.data })
      .from(monthlyRecaps)
      .where(
        and(
          eq(monthlyRecaps.profileId, profileId),
          eq(monthlyRecaps.month, month),
        ),
      );
    return row ? pick(row.data as MonthlyRecapData) : null;
  });
}
