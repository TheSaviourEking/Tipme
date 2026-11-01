// Release rehearsal (PR-010).

/** `test` copies may run the full release check; `live` copies (real people) only read-only. */
export type ReleaseKind = 'test' | 'live';

export interface ReleaseInfo {
  kind: ReleaseKind;
  version: string;
  deploymentMode: 'production' | 'preview';
  paymentsLive: boolean;
  analytics: boolean;
  /** Which checkout a tip goes through: the release check completes a pretend one only. */
  paymentProvider: 'mock' | 'bachs-sandbox' | 'bachs-live';
}

/** GET /health/backups (PR-011): how old the newest backups are, and the WAL archiver's state. */
export interface BackupHealth {
  /** Base backups and archived WAL are expected; false when switched off on purpose. */
  pointInTime: boolean;
  logical: { ageMinutes: number } | null;
  base: { ageMinutes: number } | null;
  wal: {
    archiving: boolean;
    lastArchivedAgeMinutes: number | null;
    lastFailedAgeMinutes: number | null;
    failedCount: number;
  };
  /** The newest backup retention run (staging's local Postgres); null before the first. */
  retention: {
    lastRunAgeMinutes: number;
    mode: 'dry-run' | 'apply';
    outcome: 'planned' | 'applied' | 'blocked' | 'failed';
    /** Why pruning is blocked, as codes: no file or segment names on this public route. */
    blocked: RetentionBlock[];
    archiveBytes: number;
    candidateBytes: number;
    diskFreePercent: number;
  } | null;
}

export type RetentionBlock =
  | 'backup-running'
  | 'no-verified-backup'
  | 'no-drill'
  | 'wal-gap'
  | 'archive-missing'
  | 'other';

/**
 * GET /health/payments: whether the platform's payment reserve is running low, for the watcher.
 * Public, so it carries no amount, provider or detail. A reserve that could not be read cannot be
 * confirmed fine, so it also says `reserveLow: true`, with `unreadable` to tell the two apart.
 * `readAt` is when the worker last read it (null before the first read, e.g. on a copy that does
 * not run a Bachs provider): an old time means the worker has stopped checking.
 */
export interface PaymentsHealth {
  reserveLow: boolean;
  unreadable: boolean;
  readAt: string | null;
}
