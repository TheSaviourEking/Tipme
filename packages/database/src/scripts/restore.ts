import { restoreBackup } from '../backup/backup.js';

// A REAL restore (incident only; see docs/runbooks/backup-and-restore.md). Replaces the database
// in DATABASE_URL with BACKUP_FILE: stop the api, worker and backup containers first, and name
// the database in RESTORE_CONFIRM_DATABASE. The result is proved against the backup's manifest.
const env = process.env;
try {
  const file = env['BACKUP_FILE'];
  if (!file)
    throw new Error(
      'set BACKUP_FILE to the backup to restore (run the drill on it first)',
    );
  const result = await restoreBackup({
    url: env['DATABASE_URL'] ?? '',
    key: env['BACKUP_KEY'] ?? '',
    file,
    confirmDatabase: env['RESTORE_CONFIRM_DATABASE'] ?? '',
    pgExec: env['BACKUP_PG_EXEC']
      ? env['BACKUP_PG_EXEC'].split(' ')
      : undefined,
  });
  if (result.ok) console.log(`Restore DONE and proved from ${file}.`);
  else {
    console.error(`Restore FINISHED WITH PROBLEMS from ${file}:`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Restore failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
