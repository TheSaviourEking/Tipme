import type { ProfileReportReason } from '@tipme/contracts';
import { normaliseHandle } from '@tipme/domain';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { issues, profileReports, profiles } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';

const minuteOf = (now: Date) =>
  new Date(Math.floor(now.getTime() / 60_000) * 60_000);

/**
 * A visitor reports a live page (PR-013, PRD v1.1 FR-01): impersonation, a scam, abuse or other.
 * Stored as the page, the reason and the minute only. The first report since the page's last
 * review opens a `profile_reported` issue; later ones only add to its counts. Unknown or hidden
 * pages store nothing, and the caller answers the same either way.
 */
export function reportProfile(
  db: Database,
  input: { handle: string; reason: ProfileReportReason; now?: Date },
): Promise<'reported' | 'ignored'> {
  const now = input.now ?? new Date();
  const handle = normaliseHandle(input.handle);
  if (!handle) return Promise.resolve('ignored');
  return guarded(() =>
    db.transaction(async (tx) => {
      const [page] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.handleLower, handle),
            eq(profiles.pageState, 'live'),
            eq(profiles.status, 'active'),
          ),
        );
      if (!page) return 'ignored' as const;
      // Reports for one page wait for each other (so they open one issue), without locking the
      // page row that a public endpoint must never hold up.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`tipme.report:${page.id}`}))`,
      );
      const reportId = newId();
      await tx.insert(profileReports).values({
        id: reportId,
        profileId: page.id,
        reason: input.reason,
        atMinute: minuteOf(now),
      });
      // Issues are never reopened: after a review, the next report starts a new one.
      const [open] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.kind, 'profile_reported'),
            eq(issues.status, 'open'),
            sql`${issues.subject}->>'profileId' = ${page.id}`,
          ),
        )
        .limit(1);
      if (!open)
        await openIssue(tx, {
          dedupeKey: `profile_report.${page.id}.${reportId}`,
          kind: 'profile_reported',
          subject: { profileId: page.id },
          now,
        });
      return 'reported' as const;
    }),
  );
}

/** Counts by reason of a page's reports since an issue opened (the evidence view). */
export async function pageReportCounts(
  db: Database,
  profileId: string,
  since: Date,
): Promise<{ reason: ProfileReportReason; count: number }[]> {
  const rows = await db
    .select({
      reason: profileReports.reason,
      count: sql<number>`count(*)::int`,
    })
    .from(profileReports)
    .where(
      and(
        eq(profileReports.profileId, profileId),
        sql`${profileReports.atMinute} >= date_trunc('minute', ${since}::timestamptz)`,
      ),
    )
    .groupBy(profileReports.reason)
    .orderBy(profileReports.reason);
  return rows as { reason: ProfileReportReason; count: number }[];
}

/** Reports are kept 180 days (PR-013): long enough to review a pattern, not for ever. */
export const PROFILE_REPORT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export function purgeProfileReports(
  db: Database,
  input: { now: Date },
): Promise<number> {
  return guarded(async () => {
    const removed = await db
      .delete(profileReports)
      .where(
        lt(
          profileReports.atMinute,
          new Date(input.now.getTime() - PROFILE_REPORT_RETENTION_MS),
        ),
      )
      .returning({ id: profileReports.id });
    return removed.length;
  });
}
