import { desc } from 'drizzle-orm';
import pg from 'pg';
import { createDatabase, type Database } from './client.js';
import { assertLocalDatabaseUrl } from './local-only.js';
import { runMigrations } from './migrations.js';
import type { MailSealing } from './operations/mail-queue.js';
import { openSecret } from './operations/secret-box.js';
import { mailMessages } from './schema.js';

const TEST_DATABASE = 'tipme_test';
const DEFAULT_URL =
  'postgres://tipme_local:tipme_local_password@127.0.0.1:5432/tipme_local';
// Only names this module makes: they go into CREATE/DROP DATABASE unquoted-safe.
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,40}$/;

function serverUrl(): string {
  const base = process.env['DATABASE_URL'] ?? DEFAULT_URL;
  assertLocalDatabaseUrl(base);
  return base;
}

function urlFor(name: string): string {
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

async function asAdmin<T>(work: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: serverUrl() });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

function checkedName(name: string): string {
  if (!DATABASE_NAME.test(name))
    throw new Error(`not a test database name: ${name}`);
  return name;
}

/**
 * Creates `template` afresh and migrates it. With TIPME_TEST_TEMPLATE set to it, every test
 * process then works in its own copy (openTestDatabase), so test files can run in parallel.
 */
export async function prepareTestTemplate(template: string): Promise<void> {
  checkedName(template);
  await dropTestDatabases(template);
  await asAdmin((admin) => admin.query(`CREATE DATABASE ${template}`));
  const handle = createDatabase(urlFor(template));
  try {
    await runMigrations(handle.db);
  } finally {
    await handle.close();
  }
}

/** Drops the template and every per-process copy made from it. */
export async function dropTestDatabases(template: string): Promise<void> {
  checkedName(template);
  await asAdmin(async (admin) => {
    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = $1 OR datname ~ ('^' || $1 || '_[0-9]+$')`,
      [template],
    );
    for (const { datname } of rows)
      await admin.query(
        `DROP DATABASE IF EXISTS ${checkedName(datname)} WITH (FORCE)`,
      );
  });
}

export interface TestDatabase {
  db: Database;
  pool: pg.Pool;
  url: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A migrated test database on the local server. Test-only. Normally the shared `tipme_test`;
 * with TIPME_TEST_TEMPLATE set, this process's own copy of that template.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const template = process.env['TIPME_TEST_TEMPLATE'];
  const name = template
    ? checkedName(`${checkedName(template)}_${process.pid}`)
    : TEST_DATABASE;
  await asAdmin(async (admin) => {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (exists.rowCount !== 0) return;
    await admin.query(
      template
        ? `CREATE DATABASE ${name} TEMPLATE ${template}`
        : `CREATE DATABASE ${name}`,
    );
  });
  const url = urlFor(name);
  const handle = createDatabase(url);
  await runMigrations(handle.db);
  return {
    db: handle.db,
    pool: handle.pool,
    url,
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

/**
 * Queued mail, newest first, with the sealed address and data opened: tests read codes and links
 * from here, as a person would from their inbox.
 */
export async function queuedMail(
  db: Database,
  sealing: MailSealing,
  input: { limit: number },
): Promise<
  Array<{
    id: string;
    type: string;
    status: string;
    toHint: string;
    userId: string | null;
    to: string | null;
    data: Record<string, unknown> | null;
  }>
> {
  const rows = await db
    .select()
    .from(mailMessages)
    .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(input.limit);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    toHint: row.toHint,
    userId: row.userId,
    to: row.toSealed ? openSecret(sealing.key, row.toSealed) : null,
    data: row.dataSealed
      ? (JSON.parse(openSecret(sealing.key, row.dataSealed)) as Record<
          string,
          unknown
        >)
      : null,
  }));
}
