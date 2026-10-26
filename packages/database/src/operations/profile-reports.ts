import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { PROFILE_REPORT_REASONS, profileReports, profiles } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';

export type ProfileReportReason = (typeof PROFILE_REPORT_REASONS)[number];

/**
 * Anyone reports a live public page (impersonation, scam, abuse). Each report is kept; reports of
 * one page on one Lagos day share one issue in the staff inbox. Pages that aren't publicly live
 * answer like unknown ones, so a report never reveals whether a hidden page exists.
 */
export function reportProfile(
  db: Database,
  input: {
    handle: string;
    reason: ProfileReportReason;
    details?: string;
    now?: Date;
  },
): Promise<{ reported: true }> {
  const now = input.now ?? new Date();
  const details = input.details?.trim().slice(0, 500) || null;
  return guarded(() =>
    db.transaction(async (tx) => {
      const [page] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.handleLower, input.handle.toLowerCase()),
            eq(profiles.status, 'active'),
            eq(profiles.pageState, 'live'),
            eq(profiles.visibility, 'public'),
          ),
        );
      if (!page) throw new OperationError('PROFILE_NOT_FOUND');
      await tx.insert(profileReports).values({
        id: newId(),
        profileId: page.id,
        reason: input.reason,
        details,
        createdAt: now,
      });
      const lagosDay = new Date(now.getTime() + 3_600_000)
        .toISOString()
        .slice(0, 10);
      await openIssue(tx, {
        dedupeKey: `profile_report.${page.id}.${lagosDay}`,
        kind: 'profile_reported',
        subject: { profileId: page.id },
        now,
      });
      return { reported: true as const };
    }),
  );
}

/** A page's reports for staff, newest first. */
export function listProfileReports(
  db: Database,
  profileId: string,
  limit = 20,
): Promise<
  { id: string; reason: string; details: string | null; createdAt: string }[]
> {
  return guarded(async () => {
    const rows = await db
      .select({
        id: profileReports.id,
        reason: profileReports.reason,
        details: profileReports.details,
        createdAt: profileReports.createdAt,
      })
      .from(profileReports)
      .where(eq(profileReports.profileId, profileId))
      .orderBy(desc(profileReports.createdAt))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}
