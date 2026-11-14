import type { PagePlan } from '@tipme/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { planChanges, profiles } from '../schema.js';
import { newId } from './ids.js';

/*
 * Plan history (plan 2026-11-14 Task 2). `recomputePlan` notes each change of `profiles.plan` here,
 * in its own transaction, so the history and the plan never disagree. Statements read which days
 * were Pro; goals count only tips confirmed while the page was Pro (ruling G6).
 */

export interface ProSpan {
  from: Date;
  to: Date;
}

/** Records that the page's plan became `plan` at `at`. Called only from `recomputePlan`. */
export async function notePlanChange(
  tx: Tx,
  profileId: string,
  plan: PagePlan,
  at: Date,
): Promise<void> {
  await tx
    .insert(planChanges)
    .values({ id: newId(), profileId, plan, changedAt: at });
}

/**
 * The half-open intervals inside `[from, to)` during which the page was Pro, oldest first. Before
 * its first recorded change a page was Free. A page with no history at all (none recorded yet)
 * reads its current plan for the whole range.
 */
export async function proSpans(
  db: Database | Tx,
  profileId: string,
  from: Date,
  to: Date,
): Promise<ProSpan[]> {
  if (!(from < to)) return [];
  // Each change with the time the next one starts (LAG's mirror), up to the window's end.
  const rows = await db.execute<{
    plan: string;
    starts: Date | string;
    ends: Date | string | null;
  }>(sql`
    SELECT plan, changed_at AS starts,
           LEAD(changed_at) OVER (ORDER BY changed_at, id) AS ends
      FROM plan_changes
     WHERE profile_id = ${profileId} AND changed_at < ${to.toISOString()}::timestamptz
     ORDER BY changed_at, id`);
  if (rows.rows.length === 0) {
    const [any] = await db
      .select({ id: planChanges.id })
      .from(planChanges)
      .where(eq(planChanges.profileId, profileId))
      .limit(1);
    if (any) return []; // the first change is after the window: Free throughout
    const [page] = await db
      .select({ plan: profiles.plan })
      .from(profiles)
      .where(eq(profiles.id, profileId));
    return page?.plan === 'pro' ? [{ from, to }] : [];
  }
  const spans: ProSpan[] = [];
  for (const row of rows.rows) {
    if (row.plan !== 'pro') continue;
    const start = new Date(row.starts);
    const end = row.ends === null ? to : new Date(row.ends);
    const clippedFrom = start > from ? start : from;
    const clippedTo = end < to ? end : to;
    if (!(clippedFrom < clippedTo)) continue;
    const last = spans[spans.length - 1];
    // Two `pro` rows in a row (a backfill then a note) are one span.
    if (last && last.to.getTime() === clippedFrom.getTime())
      last.to = clippedTo;
    else spans.push({ from: clippedFrom, to: clippedTo });
  }
  return spans;
}

/** Whether `at` falls inside one of the spans. */
export function wasProAt(spans: readonly ProSpan[], at: Date): boolean {
  const t = at.getTime();
  return spans.some(
    (span) => span.from.getTime() <= t && t < span.to.getTime(),
  );
}
