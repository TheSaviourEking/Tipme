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
 * GET /health/payments: for the watcher. Public, so it carries no amount, provider or detail.
 * `reserveLow` means the reserve was read and is low, nothing else; `unreadable` means the last
 * read failed. The worker alerts on both (once, then every 6 hours), so a watcher only prints them.
 * `stale` is the one the watcher alarms on, because a stopped worker cannot alert for itself: true
 * when the provider is Bachs live with payments on and nothing was read for over 45 minutes (or
 * ever). `readAt` is when the worker last read the reserve (null before the first read).
 */
export interface PaymentsHealth {
  reserveLow: boolean;
  unreadable: boolean;
  stale: boolean;
  readAt: string | null;
  /**
   * False when this API's live state isn't what the record of switches says: a failed record, or
   * a deploy that failed partway. The watcher raises it. Older APIs send nothing.
   */
  switchRecordMatches?: boolean;
}
