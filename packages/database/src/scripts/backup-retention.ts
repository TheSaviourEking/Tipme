import pg from 'pg';
import { runRetention, type RetentionFacts } from '../backup/retention-run.js';

// The backup retention coordinator, once (the `retention` service runs it hourly). Dry run unless
// RETENTION_MODE=apply. Staging's local Postgres only: production's database is managed by Aiven.
// Prints no secrets: the key is never logged and database URLs are masked.
const env = process.env;
const mask = (text: string) => text.replace(/postgres(ql)?:\/\/\S+/g, '<url>');
const int = (name: string) =>
  env[name] !== undefined && env[name] !== '' ? Number(env[name]) : undefined;

async function facts(client: pg.Client): Promise<RetentionFacts> {
  const has = async (table: string) =>
    Boolean(
      (
        await client.query<{ t: string | null }>(
          'SELECT to_regclass($1) AS t',
          [table],
        )
      ).rows[0]?.t,
    );
  const recordedFiles = (await has('public.backup_runs'))
    ? (
        await client.query<{ file: string }>(
          "SELECT file FROM backup_runs WHERE kind = 'base'",
        )
      ).rows.map((r) => r.file)
    : [];
  const activeBackup =
    Number(
      (
        await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM pg_stat_progress_basebackup',
        )
      ).rows[0]?.n ?? 0,
    ) > 0;
  const lastArchived =
    (
      await client.query<{ w: string | null }>(
        'SELECT last_archived_wal AS w FROM pg_stat_archiver',
      )
    ).rows[0]?.w ?? null;
  const drill = (await has('public.recovery_drills'))
    ? (
        await client.query<{ at: Date | null }>(
          'SELECT max(ran_at) AS at FROM recovery_drills WHERE passed',
        )
      ).rows[0]?.at
    : null;
  return {
    recordedFiles,
    activeBackup,
    lastArchived,
    lastDrillPassAt: drill ?? null,
  };
}

const mode = env['RETENTION_MODE'] === 'apply' ? 'apply' : 'dry-run';
const keepDays = int('RETENTION_KEEP_DAYS');
const client = new pg.Client({ connectionString: env['DATABASE_URL'] ?? '' });
try {
  await client.connect();
  const result = await runRetention({
    now: new Date(),
    walDir: env['WAL_DIR'] ?? '/wal',
    backupDir: env['BACKUP_DIR'] ?? '/backups',
    key: env['BACKUP_KEY'] ?? '',
    mode,
    policy: {
      // Without a window, the newest 7 (what the backup run kept before this coordinator).
      ...(keepDays !== undefined
        ? { keepDays }
        : { keepCount: int('RETENTION_KEEP_COUNT') ?? 7 }),
      minKeep: int('RETENTION_MIN_KEEP') ?? 2,
      drillMaxAgeDays: int('RETENTION_DRILL_MAX_AGE_DAYS') ?? 7,
    },
    facts: await facts(client),
  });
  console.log(result.report);
  console.log(
    JSON.stringify({
      event: 'backup.retention',
      mode,
      outcome: result.outcome,
      blocked: result.plan.blocked,
      candidates: result.plan.candidates.length,
      candidateBytes: result.plan.candidateBytes,
      deletedBytes: result.deletedBytes,
      archiveBytes: result.plan.archiveBytes,
      diskFreeBytes: result.disk.freeBytes,
    }),
  );
  if (result.outcome !== 'busy') {
    const exists = (
      await client.query<{ t: string | null }>(
        "SELECT to_regclass('public.backup_retention_runs') AS t",
      )
    ).rows[0]?.t;
    if (exists)
      await client.query(
        `INSERT INTO backup_retention_runs (id, ran_at, mode, outcome, blocked, retained_backups,
           boundary, archive_bytes, candidate_bytes, deleted_bytes, disk_free_bytes, disk_total_bytes)
         VALUES (gen_random_uuid(), now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          mode,
          result.plan.blocked.length && mode === 'apply'
            ? 'blocked'
            : result.outcome,
          result.plan.blocked.join('\n'),
          result.plan.backups.filter((b) => b.status === 'retained').length,
          result.plan.boundary,
          result.plan.archiveBytes,
          result.plan.candidateBytes,
          result.deletedBytes,
          result.disk.freeBytes,
          result.disk.totalBytes,
        ],
      );
  }
} catch (error) {
  const message = mask((error as Error).message);
  console.error(JSON.stringify({ event: 'backup.retention.failed', message }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
