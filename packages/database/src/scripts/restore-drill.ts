import { latestBackup, restoreDrill } from '../backup/backup.js';

// The restore drill: the newest backup (or BACKUP_FILE) into a scratch database, then proved.
const env = process.env;
try {
  const file =
    env['BACKUP_FILE'] ?? (await latestBackup(env['BACKUP_DIR'] ?? '/backups'));
  if (!file) throw new Error('no backup found');
  const result = await restoreDrill({
    url: env['DATABASE_URL'] ?? '',
    key: env['BACKUP_KEY'] ?? '',
    file,
    pgExec: env['BACKUP_PG_EXEC']
      ? env['BACKUP_PG_EXEC'].split(' ')
      : undefined,
  });
  if (result.ok) console.log(`Restore drill PASSED for ${file}.`);
  else {
    console.error(`Restore drill FAILED for ${file}:`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Restore drill failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
