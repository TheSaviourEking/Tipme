import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The database roles (deploy/postgres/roles.sql), applied over a connection: for a database the
// app can't reach with psql inside its container, such as a managed one (Aiven). Staging's local
// Postgres runs the same file through bootstrap-roles.sh.

/** deploy/postgres/roles.sql, from the repository root (it is copied into the app image). */
export const ROLES_SQL = fileURLToPath(
  new URL('../../../deploy/postgres/roles.sql', import.meta.url),
);

const PASSWORD = /^[A-Za-z0-9_-]{16,}$/;

export async function applyDatabaseRoles(input: {
  /** The database's admin: owns the database and has CREATEROLE. Never logged. */
  adminUrl: string;
  passwords: { runtime: string; migrator: string; backup: string };
  sqlPath?: string;
}): Promise<void> {
  for (const [role, password] of Object.entries(input.passwords))
    if (!PASSWORD.test(password))
      throw new Error(
        `the ${role} password must be at least 16 letters, digits, '-' or '_'`,
      );
  const sql = await readFile(input.sqlPath ?? ROLES_SQL, 'utf8');
  const client = new pg.Client({ connectionString: input.adminUrl });
  await client.connect();
  try {
    for (const [role, password] of Object.entries(input.passwords))
      await client.query('SELECT set_config($1, $2, false)', [
        `tipme.${role}_password`,
        password,
      ]);
    await client.query(sql);
  } finally {
    await client.end();
  }
}
