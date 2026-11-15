import { sqlStateOf } from './operations/errors.js';

// SQLSTATEs a release migration may meet when it collides with live traffic for a moment:
// 40P01 deadlock_detected (Postgres picked the migration as the victim) and 55P03
// lock_not_available (lock_timeout gave up on a table lock). Nothing else is retried: a syntax
// error, a constraint the data breaks or a lost connection needs a person, not another go.
const RETRYABLE = new Set(['40P01', '55P03']);

export const MIGRATE_ATTEMPTS = 3;
// Long enough for the short job or request that held the lock to commit and move on.
export const MIGRATE_RETRY_DELAYS_MS = [5_000, 15_000] as const;

export interface MigrateRetryOptions {
  attempts?: number;
  /** The wait before attempt n + 2 (the last value repeats). */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: {
    attempt: number;
    sqlState: string;
    delayMs: number;
  }) => void;
}

/**
 * Runs the migrations, again after a deadlock or a lock timeout. Safe to repeat: drizzle applies
 * every pending migration in ONE transaction, so a failed attempt rolls back entirely and the
 * next starts from the same schema (it re-reads which migrations are applied). Gives up after
 * `attempts` and throws the last error.
 */
export async function migrateWithRetry(
  run: () => Promise<void>,
  {
    attempts = MIGRATE_ATTEMPTS,
    delaysMs = MIGRATE_RETRY_DELAYS_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry,
  }: MigrateRetryOptions = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (attempt >= attempts || !sqlState || !RETRYABLE.has(sqlState))
        throw error;
      const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
      onRetry?.({ attempt, sqlState, delayMs });
      await sleep(delayMs);
    }
  }
}
