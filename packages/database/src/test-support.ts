import pg from 'pg';
import { createDatabase, type Database } from './client.js';
import { assertLocalDatabaseUrl } from './local-only.js';
import { runMigrations } from './migrations.js';

const TEST_DATABASE = 'tipme_test';
const DEFAULT_URL =
  'postgres://tipme_local:tipme_local_password@127.0.0.1:5432/tipme_local';

export interface TestDatabase {
  db: Database;
  pool: pg.Pool;
  url: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A migrated `tipme_test` database on the local server. Test-only. */
export async function openTestDatabase(): Promise<TestDatabase> {
  const base = process.env['DATABASE_URL'] ?? DEFAULT_URL;
  assertLocalDatabaseUrl(base);
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [TEST_DATABASE],
    );
    if (exists.rowCount === 0)
      await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE}`;
  const handle = createDatabase(url.toString());
  await runMigrations(handle.db);
  return {
    db: handle.db,
    pool: handle.pool,
    url: url.toString(),
    async reset() {
      const { rows } = await handle.pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      if (rows.length === 0) return;
      const client = await handle.pool.connect();
      try {
        // History tables refuse TRUNCATE unless this transaction opts in (test resets only).
        await client.query('BEGIN');
        await client.query(`SET LOCAL tipme.allow_truncate = 'on'`);
        await client.query(
          `TRUNCATE ${rows.map((row) => `"${row.tablename}"`).join(', ')} CASCADE`,
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: handle.close,
  };
}
