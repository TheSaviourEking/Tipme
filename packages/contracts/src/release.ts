// Release rehearsal (PR-010).

/** `test` copies may run the full release check; `live` copies (real people) only read-only. */
export type ReleaseKind = 'test' | 'live';

export interface ReleaseInfo {
  kind: ReleaseKind;
  version: string;
  deploymentMode: 'production' | 'preview';
  paymentsLive: boolean;
  analytics: boolean;
}

/** GET /health/backups (PR-011): how old the newest backups are, and the WAL archiver's state. */
export interface BackupHealth {
  logical: { ageMinutes: number } | null;
  base: { ageMinutes: number } | null;
  wal: {
    archiving: boolean;
    lastArchivedAgeMinutes: number | null;
    lastFailedAgeMinutes: number | null;
    failedCount: number;
  };
}
