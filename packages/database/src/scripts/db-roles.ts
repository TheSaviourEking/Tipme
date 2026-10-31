import { applyDatabaseRoles } from '../roles.js';

// Sets up the runtime, migrator and backup roles on a database reached over the network (a managed
// Postgres such as Aiven), as its admin. Run before and after migrating. Prints no secrets.
//   DATABASE_ADMIN_URL=postgres://avnadmin:…@host:port/tipme?sslmode=verify-full&sslrootcert=…
//   POSTGRES_RUNTIME_PASSWORD, POSTGRES_MIGRATOR_PASSWORD, POSTGRES_BACKUP_PASSWORD
const env = process.env;
try {
  await applyDatabaseRoles({
    adminUrl: env['DATABASE_ADMIN_URL'] ?? '',
    passwords: {
      runtime: env['POSTGRES_RUNTIME_PASSWORD'] ?? '',
      migrator: env['POSTGRES_MIGRATOR_PASSWORD'] ?? '',
      backup: env['POSTGRES_BACKUP_PASSWORD'] ?? '',
    },
  });
  console.log('Database roles are set up.');
} catch (error) {
  console.error(
    `Database roles failed: ${(error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`,
  );
  process.exitCode = 1;
}
