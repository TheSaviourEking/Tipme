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
  paymentProvider: 'mock' | 'bachs-sandbox';
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
