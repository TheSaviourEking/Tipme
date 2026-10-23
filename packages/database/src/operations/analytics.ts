import {
  WEB_VITAL_BUDGETS,
  WEB_VITAL_METRICS,
  type AnalyticsEvent,
  type AnalyticsServerEvent,
  type WebVital,
  type WebVitalSummary,
} from '@tipme/contracts';
import { eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { analyticsEvents, profiles, webVitals } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

const ZONE = 'Africa/Lagos';
const minuteOf = (now: Date) =>
  new Date(Math.floor(now.getTime() / 60_000) * 60_000);

/** The handle, lower-cased, only if such a page exists (anything else is dropped), and whether
 *  that page belongs to the release check. */
async function knownHandle(
  db: Database,
  handle: string | undefined,
): Promise<{ handle: string | null; rehearsal: boolean }> {
  if (!handle) return { handle: null, rehearsal: false };
  const lower = handle.toLowerCase();
  const [row] = await db
    .select({ handle: profiles.handleLower, run: profiles.rehearsalRunId })
    .from(profiles)
    .where(eq(profiles.handleLower, lower));
  return row
    ? { handle: lower, rehearsal: Boolean(row.run) }
    : { handle: null, rehearsal: false };
}

/** Stores one validated browser event (already checked against the contract's allow-list). */
export function recordClientEvent(
  db: Database,
  input: { event: AnalyticsEvent; device: 'mobile' | 'desktop'; now?: Date },
): Promise<void> {
  return guarded(async () => {
    const { event } = input;
    const page = await knownHandle(db, event.handle);
    await db.insert(analyticsEvents).values({
      id: newId(),
      atMinute: minuteOf(input.now ?? new Date()),
      name: event.name,
      flowId: event.flowId,
      surface: event.surface ?? null,
      channel: event.channel ?? null,
      handle: page.handle,
      rehearsal: page.rehearsal,
      returning: event.returning ?? null,
      device: input.device,
    });
  });
}

/** One real-user web vital (already checked against the contract). Rounded: whole milliseconds,
 *  CLS to 3 decimals, so the value cannot carry anything else. */
export function recordWebVital(
  db: Database,
  input: { vital: WebVital; device: 'mobile' | 'desktop'; now?: Date },
): Promise<void> {
  const { vital } = input;
  const value =
    vital.metric === 'CLS'
      ? Math.round(vital.value * 1000) / 1000
      : Math.round(vital.value);
  return guarded(async () => {
    await db.insert(webVitals).values({
      id: newId(),
      atMinute: minuteOf(input.now ?? new Date()),
      metric: vital.metric,
      value,
      page: vital.page,
      device: input.device,
    });
  });
}

/** p75 per metric over mobile visits in the last `days` days, against the PRD budgets. */
export function webVitalsSummary(
  db: Database,
  input: { now: Date; days: number },
): Promise<WebVitalSummary[]> {
  return guarded(async () => {
    const since = new Date(input.now.getTime() - input.days * 86_400_000);
    const { rows } = await db.execute(sql`
      SELECT metric, count(*)::int AS samples,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75
        FROM web_vitals
       WHERE device = 'mobile' AND at_minute >= ${since}
       GROUP BY metric`);
    const found = new Map(
      (rows as { metric: string; samples: number; p75: number }[]).map((r) => [
        r.metric,
        r,
      ]),
    );
    return WEB_VITAL_METRICS.map((metric) => {
      const row = found.get(metric);
      const budget = WEB_VITAL_BUDGETS[metric] ?? null;
      const p75 =
        row === undefined
          ? null
          : metric === 'CLS'
            ? Math.round(Number(row.p75) * 1000) / 1000
            : Math.round(Number(row.p75));
      return {
        metric,
        p75,
        samples: row?.samples ?? 0,
        budget,
        withinBudget: p75 === null || budget === null ? null : p75 <= budget,
      };
    });
  });
}

/** An outcome from verified server state, once per `dedupeKey` (workers deliver at least once). */
export function recordServerEvent(
  db: Database,
  input: {
    name: AnalyticsServerEvent;
    dedupeKey: string;
    profileId?: string;
    at?: Date;
  },
): Promise<'recorded' | 'duplicate'> {
  return guarded(async () => {
    let handle: string | null = null;
    let rehearsal = false;
    if (input.profileId) {
      const [row] = await db
        .select({ handle: profiles.handleLower, run: profiles.rehearsalRunId })
        .from(profiles)
        .where(eq(profiles.id, input.profileId));
      handle = row?.handle ?? null;
      rehearsal = Boolean(row?.run);
    }
    const inserted = await db
      .insert(analyticsEvents)
      .values({
        id: newId(),
        atMinute: minuteOf(input.at ?? new Date()),
        name: input.name,
        handle,
        rehearsal,
        dedupeKey: input.dedupeKey,
      })
      .onConflictDoNothing({ target: analyticsEvents.dedupeKey })
      .returning({ id: analyticsEvents.id });
    return inserted.length > 0 ? 'recorded' : 'duplicate';
  });
}

/**
 * Daily totals for one Lagos date (YYYY-MM-DD); rerunning replaces them. A visit is one tab session
 * on one page, and its channel is how that first view arrived, so channels add up to visits.
 */
export function rollupAnalytics(
  db: Database,
  input: { date: string },
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
    return Promise.reject(new Error('date must be YYYY-MM-DD'));
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`DELETE FROM analytics_daily WHERE date = ${input.date}::date`,
      );
      await tx.execute(sql`
        WITH day AS (
          SELECT * FROM analytics_events
           WHERE (at_minute AT TIME ZONE ${ZONE})::date = ${input.date}::date
             AND NOT rehearsal
        ),
        visits AS (
          SELECT DISTINCT ON (flow_id, coalesce(handle, ''))
                 flow_id, coalesce(handle, '') AS handle, coalesce(channel, 'other') AS channel,
                 coalesce("returning", false) AS is_returning
            FROM day
           WHERE name = 'profile_viewed' AND flow_id IS NOT NULL
           ORDER BY flow_id, coalesce(handle, ''), at_minute, id
        ),
        totals (metric, dimension, value) AS (
          SELECT 'events.' || name, coalesce(channel, ''), count(*) FROM day GROUP BY 1, 2
          UNION ALL SELECT 'visits', '', count(*) FROM visits
          UNION ALL SELECT 'returning_visits', '', count(*) FROM visits WHERE is_returning
          UNION ALL SELECT 'visits_by_channel', channel, count(*) FROM visits GROUP BY 2
          UNION ALL SELECT 'visits_by_handle', handle, count(*) FROM visits WHERE handle <> '' GROUP BY 2
        )
        INSERT INTO analytics_daily (date, metric, dimension, value)
        SELECT ${input.date}::date, metric, dimension, value FROM totals WHERE value > 0`);
    }),
  );
}

/** Deletes raw events older than `before` (90 days in production; the daily totals stay). */
export function purgeAnalytics(
  db: Database,
  input: { before: Date },
): Promise<number> {
  return guarded(async () => {
    const deleted = await db
      .delete(analyticsEvents)
      .where(lt(analyticsEvents.atMinute, input.before))
      .returning({ id: analyticsEvents.id });
    const vitals = await db
      .delete(webVitals)
      .where(lt(webVitals.atMinute, input.before))
      .returning({ id: webVitals.id });
    return deleted.length + vitals.length;
  });
}

/** Lagos dates (YYYY-MM-DD) from `days` days ago up to yesterday, for the rollup job. */
export function lagosDaysBefore(now: Date, days: number): string[] {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const out: string[] = [];
  for (let back = days; back >= 1; back--)
    out.push(format.format(new Date(now.getTime() - back * 86_400_000)));
  return out;
}
