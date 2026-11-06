import {
  CHANGELOG_RELEASE_LIMIT,
  draftFromPullRequest,
  type ChangelogDraft,
  type ChangelogPendingEntry,
} from '@tipme/contracts';
import { and, asc, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { changelogEntries } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded } from './errors.js';

// The changelog (plan of 5 Nov 2026): signed facts from CI. Drafts come from merged PRs; the
// deploy jobs say which entries the running version contains. Nothing here reads GitHub.

export type ChangelogEnvironment = 'staging' | 'production';

/**
 * Records a merged PR as a draft. The body is parsed for the staff and user texts and then
 * dropped: it is never stored or written to the audit log. A PR already recorded is left exactly
 * as it is (a re-run or a resend never undoes staff edits).
 */
export function recordChangelogDraft(
  db: Database,
  pr: ChangelogDraft,
  now: Date = new Date(),
): Promise<{ created: boolean }> {
  const draft = draftFromPullRequest({ title: pr.title, body: pr.body });
  return guarded(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(changelogEntries)
        .values({
          prNumber: pr.number,
          mergeSha: pr.mergeCommitSha,
          mergedAt: new Date(pr.mergedAt),
          prTitle: pr.title,
          staffText: draft.staffText,
          userText: draft.userText,
          audience: draft.audience,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: changelogEntries.prNumber })
        .returning({ number: changelogEntries.prNumber });
      if (inserted.length === 0) return { created: false };
      await recordAudit(tx, {
        staffUserId: null,
        action: 'changelog.drafted',
        subjectType: 'changelog_entry',
        subjectId: String(pr.number),
        reason: `#${pr.number}, revision 1`,
        now,
      });
      return { created: true };
    }),
  );
}

const reachedColumn = (environment: ChangelogEnvironment) =>
  environment === 'production'
    ? changelogEntries.liveAt
    : changelogEntries.stagingAt;

/**
 * The entries this environment has not yet been seen running, withdrawn ones left out: numbers
 * and merge commits only. Oldest merge first, at most CHANGELOG_RELEASE_LIMIT.
 */
export function pendingForRelease(
  db: Database,
  environment: ChangelogEnvironment,
): Promise<ChangelogPendingEntry[]> {
  return guarded(() =>
    db
      .select({
        number: changelogEntries.prNumber,
        mergeSha: changelogEntries.mergeSha,
      })
      .from(changelogEntries)
      .where(
        and(
          isNull(reachedColumn(environment)),
          isNull(changelogEntries.withdrawnAt),
        ),
      )
      .orderBy(asc(changelogEntries.mergedAt), asc(changelogEntries.prNumber))
      .limit(CHANGELOG_RELEASE_LIMIT),
  );
}

/**
 * Marks the entries a deployed version contains (the deploy job decides that by git ancestry).
 * Production fills live_at and live_version, staging fills staging_at; each only where still
 * empty, so a replay or a later version never moves the first date. Unknown numbers and withdrawn
 * entries are ignored. One `changelog.released` audit entry lists what this call marked.
 */
export function markReleased(
  db: Database,
  input: {
    environment: ChangelogEnvironment;
    version: string;
    contained: number[];
    now?: Date;
  },
): Promise<{ marked: number[] }> {
  const now = input.now ?? new Date();
  if (input.contained.length === 0) return Promise.resolve({ marked: [] });
  const set =
    input.environment === 'production'
      ? { liveAt: now, liveVersion: input.version, updatedAt: now }
      : { stagingAt: now, updatedAt: now };
  return guarded(() =>
    db.transaction(async (tx) => {
      const rows = await tx
        .update(changelogEntries)
        .set(set)
        .where(
          and(
            inArray(changelogEntries.prNumber, input.contained),
            isNull(reachedColumn(input.environment)),
            isNull(changelogEntries.withdrawnAt),
          ),
        )
        .returning({ number: changelogEntries.prNumber });
      const marked = rows.map((row) => row.number).sort((a, b) => a - b);
      // A replay that marks nothing leaves no trace.
      if (marked.length > 0)
        await recordAudit(tx, {
          staffUserId: null,
          action: 'changelog.released',
          subjectType: 'changelog_release',
          subjectId: `${input.environment}:${input.version}`,
          reason: `${input.environment} ${input.version}: ${marked.map((n) => `#${n}`).join(', ')}`,
          now,
        });
      return { marked };
    }),
  );
}
