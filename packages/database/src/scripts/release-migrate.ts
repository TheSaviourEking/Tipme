import { sqlStateOf } from '../operations/errors.js';
import { createDatabase } from '../client.js';
import { runMigrations } from '../migrations.js';
import { MIGRATE_ATTEMPTS, migrateWithRetry } from '../migrate-retry.js';

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

// Queued for a table lock, a migration holds up every statement on that table behind it (a waiting
// ACCESS EXCLUSIVE request queues every later reader too). 10 s bounds that stall for live API
// requests and still lets a short job's transaction (they commit within a few seconds) finish
// first. Deadlocks are found sooner, at Postgres's deadlock_timeout (1 s).
// Giving up, or losing a deadlock, rolls the whole batch back (drizzle runs every pending
// migration in one transaction), so the migration is simply run again a few times
// (migrate-retry.ts). The deploy pauses the workers meanwhile, so a collision should be rare.
const LOCK_TIMEOUT_MS = 10_000;
const handle = createDatabase(url, {
  max: 1,
  lockTimeoutMillis: LOCK_TIMEOUT_MS,
});
try {
  await migrateWithRetry(() => runMigrations(handle.db), {
    onRetry: ({ attempt, sqlState, delayMs }) =>
      console.error(
        `Migration attempt ${attempt} of ${MIGRATE_ATTEMPTS} collided with live traffic (SQLSTATE ${sqlState}) and was rolled back; trying again in ${delayMs / 1000} s.`,
      ),
  });
  console.log(`Migrations applied to ${database}.`);
} catch (error) {
  const state = sqlStateOf(error);
  if (state === '55P03' || state === '40P01')
    fail(
      `The migrations collided with live traffic ${MIGRATE_ATTEMPTS} times (SQLSTATE ${state}), so they were rolled back and nothing changed. Deploy again once it is quieter.`,
    );
  throw error;
} finally {
  await handle.close();
}
