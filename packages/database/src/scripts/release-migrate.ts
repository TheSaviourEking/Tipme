import { createDatabase } from '../client.js';
import { runMigrations } from '../migrations.js';

// Release migration (PR-010): the only way migrations run against a non-local database.
// The operator (deploy.sh) must name the database it means, and a backup must exist first.
const url = process.env['DATABASE_URL'];
const confirm = process.env['MIGRATE_CONFIRM_DATABASE'];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!url) fail('DATABASE_URL is not set');
let database: string;
try {
  database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
} catch {
  fail('DATABASE_URL is not a valid URL');
}
if (!confirm || confirm !== database)
  fail(
    `Refusing to migrate: set MIGRATE_CONFIRM_DATABASE to the target database name (${database ? 'it does not match' : 'none found'}).`,
  );
if (process.env['MIGRATE_BACKUP_DONE'] !== '1')
  fail(
    'Refusing to migrate: take a backup first (deploy.sh sets MIGRATE_BACKUP_DONE=1 after it).',
  );

const handle = createDatabase(url, { max: 1 });
try {
  await runMigrations(handle.db);
  console.log(`Migrations applied to ${database}.`);
} finally {
  await handle.close();
}
