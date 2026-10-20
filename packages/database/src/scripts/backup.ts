import { createBackup } from '../backup/backup.js';

// One backup now (deploy.sh, and the nightly loop in the backup container). Prints no secrets.
const env = process.env;
try {
  const manifest = await createBackup({
    url: env['DATABASE_URL'] ?? '',
    key: env['BACKUP_KEY'] ?? '',
    dir: env['BACKUP_DIR'] ?? '/backups',
    version: env['GIT_SHA'] ?? 'unknown',
    retain: Number(env['BACKUP_RETAIN'] ?? 14),
    pgExec: env['BACKUP_PG_EXEC']
      ? env['BACKUP_PG_EXEC'].split(' ')
      : undefined,
  });
  console.log(
    `Backup written: ${manifest.file} (${Object.keys(manifest.counts).length} tables).`,
  );
} catch (error) {
  console.error(`Backup failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
