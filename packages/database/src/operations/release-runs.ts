import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { releaseRuns } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { markResolved } from './issues.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Starts a release-check run (the API allows this only on `test` copies, with the check's token). */
export function openReleaseRun(db: Database): Promise<{ runId: string }> {
  return guarded(async () => {
    const runId = newId();
    await db.insert(releaseRuns).values({ id: runId });
    return { runId };
  });
}

/** Whether pages may still be tagged with this run. */
export async function isOpenReleaseRun(
  tx: Database | Tx,
  runId: string | undefined,
): Promise<boolean> {
  if (!runId || !UUID.test(runId)) return false;
  const [row] = await tx
    .select({ id: releaseRuns.id })
    .from(releaseRuns)
    .where(and(eq(releaseRuns.id, runId), isNull(releaseRuns.finishedAt)));
  return Boolean(row);
}

/**
 * Ends a run: its open issues are resolved by the system with the reason "release check"
 * (audited). Ledger, history and audit rows stay exactly as written.
 */
export function finishReleaseRun(
  db: Database,
  input: { runId: string; now?: Date },
): Promise<{ issuesClosed: number } | null> {
  if (!UUID.test(input.runId)) return Promise.resolve(null);
  const now = input.now ?? new Date();
  return guarded(async () => {
    if (!(await isOpenReleaseRun(db, input.runId))) return null;
    const open = await db.execute<{ id: string }>(sql`
      SELECT i.id FROM issues i JOIN profiles p ON p.id = (i.subject->>'profileId')::uuid
       WHERE i.status = 'open' AND i.rehearsal AND p.rehearsal_run_id = ${input.runId}`);
    let issuesClosed = 0;
    for (const row of open.rows)
      if (
        await db.transaction((tx) =>
          markResolved(tx, {
            issueId: row.id,
            resolvedBy: 'system',
            staffUserId: null,
            reason: 'release check',
            now,
          }),
        )
      )
        issuesClosed += 1;
    await db
      .update(releaseRuns)
      .set({ finishedAt: now, issuesClosed })
      .where(eq(releaseRuns.id, input.runId));
    return { issuesClosed };
  });
}
