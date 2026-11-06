import { sweepTakeBacks } from '@tipme/database';
import type { Database, MailSealing } from '@tipme/database';
import { setTimeout as sleep } from 'node:timers/promises';

/** Revalidating is best effort: the sweep's work has committed, and a slow web app can't hold the job. */
const REVALIDATE_WITHIN_MS = 10_000;

/**
 * The `usernames.take-backs` job, every minute: moves take-backs on (notice, reminder, deadline, the
 * 14-day never-reached path), then tells the web app about every page that changed username. Run
 * twice at once, the second finds nothing to do: every step re-reads under its locks.
 */
export async function handleUsernameTakeBacks(deps: {
  db: Database;
  sealing: MailSealing;
  now: () => Date;
  /** Null when no revalidation secret is set. */
  revalidate: ((handle: string) => Promise<void>) | null;
  revalidateWithinMs?: number;
  log?: (entry: Record<string, unknown>) => void;
  /** For tests: the sweep itself has its own integration tests. */
  sweep?: typeof sweepTakeBacks;
}): Promise<'swept'> {
  const result = await (deps.sweep ?? sweepTakeBacks)(deps.db, {
    sealing: deps.sealing,
    now: deps.now(),
  });
  deps.log?.({
    event: 'usernames.take_backs_swept',
    noticed: result.noticed,
    reminded: result.reminded,
    completed: result.completed,
    unreached: result.unreached,
  });
  const revalidate = deps.revalidate;
  if (revalidate && result.revalidate.length > 0) {
    const all = Promise.allSettled(
      result.revalidate.map((handle) => revalidate(handle)),
    );
    const outcome = await Promise.race([
      all.then(() => 'done' as const),
      sleep(deps.revalidateWithinMs ?? REVALIDATE_WITHIN_MS, 'late' as const, {
        ref: false,
      }),
    ]);
    if (outcome === 'late')
      deps.log?.({ event: 'usernames.take_backs_revalidate_late' });
  }
  return 'swept';
}
