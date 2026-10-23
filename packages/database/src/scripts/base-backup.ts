import { backedUpToday, createBaseBackup } from '../backup/backup.js';
import { createDatabase } from '../client.js';

// One physical base backup now (the backup container runs it nightly). Prints no secrets.
const env = process.env;
// --if-missing-today: the hourly loop; skips when today's backup is already recorded.
async function alreadyDone(): Promise<boolean> {
  if (!process.argv.includes('--if-missing-today')) return false;
  const handle = createDatabase(env['DATABASE_URL'] ?? '', { max: 1 });
  try {
    return await backedUpToday(handle.db, 'base');
  } finally {
    await handle.close();
  }
}
try {
  if (await alreadyDone()) process.exit(0);
  const { file } = await createBaseBackup({
    url: env['DATABASE_URL'] ?? '',
    key: env['BACKUP_KEY'] ?? '',
    dir: env['BACKUP_DIR'] ?? '/backups',
    version: env['GIT_SHA'] ?? 'unknown',
    retain: Number(env['BASE_BACKUP_RETAIN'] ?? 7),
    pgExec: env['BACKUP_PG_EXEC']
      ? env['BACKUP_PG_EXEC'].split(' ')
      : undefined,
  });
  console.log(`Base backup written: ${file}.`);
} catch (error) {
  console.error(
    `Base backup failed: ${(error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`,
  );
  process.exitCode = 1;
}
