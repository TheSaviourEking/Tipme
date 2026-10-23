import { backedUpToday, createBackup } from '../backup/backup.js';
import { createDatabase } from '../client.js';

// One backup now (deploy.sh, and the nightly loop in the backup container). Prints no secrets.
const env = process.env;
// --if-missing-today: the hourly loop; skips when today's backup is already recorded.
async function alreadyDone(): Promise<boolean> {
  if (!process.argv.includes('--if-missing-today')) return false;
  const handle = createDatabase(env['DATABASE_URL'] ?? '', { max: 1 });
  try {
    return await backedUpToday(handle.db, 'logical');
  } finally {
    await handle.close();
  }
}
try {
  if (await alreadyDone()) process.exit(0);
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
