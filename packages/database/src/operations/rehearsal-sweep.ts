import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guarded } from './errors.js';
import type { MailSealing } from './mail-queue.js';
import { deleteAccount } from './profiles.js';
import { finishReleaseRun } from './release-runs.js';

/**
 * Erases what release checks left behind (31 Oct 2026). A full check deletes its own account
 * and finishes its run, but one that crashed first leaves a live, tagged page. After the grace
 * period (a check takes minutes) the worker erases each tagged account through the normal
 * deletion, and finishes every run still open, which resolves its issues. Only pages tagged
 * with a rehearsal run are touched; ledger, history and audit stay as written.
 */
export function sweepRehearsals(
  db: Database,
  input: { sealing: MailSealing; olderThanMs: number; now?: Date },
): Promise<{ erased: number; runsFinished: number }> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.olderThanMs);
  return guarded(async () => {
    const leftovers = await db.execute<{ user_id: string }>(sql`
      SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id
       WHERE p.rehearsal_run_id IS NOT NULL AND p.page_state <> 'deleted'
         AND p.created_at < ${cutoff} AND u.deleted_at IS NULL`);
    let erased = 0;
    for (const { user_id: userId } of leftovers.rows) {
      await deleteAccount(db, {
        userId,
        sealing: input.sealing,
        rehearsalCleanup: true,
        now,
      });
      erased += 1;
    }
    const runs = await db.execute<{ id: string }>(sql`
      SELECT id FROM release_runs WHERE finished_at IS NULL AND created_at < ${cutoff}`);
    let runsFinished = 0;
    for (const { id } of runs.rows)
      if (await finishReleaseRun(db, { runId: id, now })) runsFinished += 1;
    return { erased, runsFinished };
  });
}
