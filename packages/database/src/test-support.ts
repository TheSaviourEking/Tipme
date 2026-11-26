import { AsyncLocalStorage } from 'node:async_hooks';
import { desc } from 'drizzle-orm';
import pg from 'pg';
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
} from './client.js';
import { assertLocalDatabaseUrl } from './local-only.js';
import { runMigrations } from './migrations.js';
import type { MailSealing } from './operations/mail-queue.js';
import { openSecret } from './operations/secret-box.js';
import { mailMessages } from './schema.js';
import { sqlStateOf } from './operations/errors.js';

// A deadlock with the test's own worker is retried this many times in all.
const RESET_ATTEMPTS = 5;

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

const LANE_DATABASE = /^tipme_test(_lane[0-9])?$/;

/**
 * The shared test database, or the e2e lane's (TIPME_TEST_DATABASE). reset() truncates every table,
 * so a name from the environment must be one of ours, never a developer's real database.
 */
export function testDatabaseName(fromEnv: string | undefined): string {
  if (fromEnv === undefined || fromEnv === '') return TEST_DATABASE;
  if (!LANE_DATABASE.test(fromEnv))
    throw new Error(
      'TIPME_TEST_DATABASE must be tipme_test or tipme_test_laneN',
    );
  return fromEnv;
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

/**
 * Makes a transaction that asks for a second connection fail its test. Production's pools are small
 * enough (docs/runbooks/remote-database.md) that this would wait on itself until it timed out.
 * Checks the code path, whatever the pool's size, and refuses the work and again at close.
 */
function refuseNestedConnections(handle: DatabaseHandle): () => void {
  const scope = new AsyncLocalStorage<{ connected: boolean; open: boolean }>();
  const found: string[] = [];
  const connect = handle.pool.connect.bind(handle.pool) as (
    ...args: unknown[]
  ) => unknown;
  (handle.pool as { connect: unknown }).connect = (...args: unknown[]) => {
    const current = scope.getStore();
    if (current?.open) {
      if (current.connected) {
        const problem = new Error(
          'A transaction asked for a second database connection while holding one.',
        );
        found.push(problem.stack ?? problem.message);
        throw problem;
      }
      current.connected = true;
    }
    return connect(...args);
  };
  const transaction = handle.db.transaction.bind(handle.db);
  handle.db.transaction = ((...args: Parameters<typeof transaction>) => {
    const current = { connected: false, open: true };
    return scope
      .run(current, () => transaction(...args))
      .finally(() => {
        current.open = false;
      });
  }) as typeof transaction;
  return () => {
    if (found.length > 0) throw new Error(found.join('\n'));
  };
}

export interface TestDatabase {
  db: Database;
  pool: pg.Pool;
  url: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A migrated test database on the local server. Test-only. Normally the shared `tipme_test`
 * (or TIPME_TEST_DATABASE, which e2e lanes set so worktrees don't share one);
 * with TIPME_TEST_TEMPLATE set, this process's own copy of that template.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const template = process.env['TIPME_TEST_TEMPLATE'];
  const name = template
    ? checkedName(`${checkedName(template)}_${process.pid}`)
    : testDatabaseName(process.env['TIPME_TEST_DATABASE']);
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
  // Room for tests that hold transactions open on purpose to race them.
  const handle = createDatabase(url, { max: 10 });
  const checkNesting = refuseNestedConnections(handle);
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
      // The file's own worker keeps sweeping while it resets, and a sweep that reads two tables in
      // one statement can meet the TRUNCATE locking them in the other order. Postgres then cancels
      // one side (40P01). When it is this side, everything here rolled back, so it tries again.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await truncateAll(rows);
          return;
        } catch (error) {
          if (attempt >= RESET_ATTEMPTS || sqlStateOf(error) !== '40P01')
            throw error;
        }
      }
    },
    async close() {
      await handle.close();
      checkNesting();
    },
  };

  async function truncateAll(rows: { tablename: string }[]): Promise<void> {
    const client = await handle.pool.connect();
    try {
      // History tables refuse TRUNCATE unless this transaction opts in (test resets only).
      await client.query('BEGIN');
      await client.query(`SET LOCAL tipme.allow_truncate = 'on'`);
      await client.query(
        `TRUNCATE ${rows.map((row) => `"${row.tablename}"`).join(', ')} CASCADE`,
      );
      // Migrations seed this row, and no row reads as withdrawals off.
      await client.query(
        `INSERT INTO withdrawals_switch (id, paused) VALUES ('global', false)`,
      );
      // And the Pro prices the migrations leave: the launch ₦2,500 (0087) as history, then
      // ₦5,000 (0093, owner 12 Nov 2026), so every test starts at ₦5,000 a month.
      await client.query(
        `INSERT INTO pro_prices (id, amount_minor, currency, effective_from, reason, created_at)
           VALUES ('00000000-0000-4000-8000-000000250000', 250000, 'NGN', now() - interval '1 second', 'Owner''s decision, 9 Nov 2026: launch Pro price ₦2,500 a month', now() - interval '1 second'),
                  ('00000000-0000-4000-8000-000000500000', 500000, 'NGN', now(), 'Owner''s pricing decision, 12 Nov 2026: Pro is ₦5,000 a month', now())`,
      );
      // And the plan fee rates 0118 seeds (owner, 18 Nov 2026): Free 500 and Pro 300 bps with the
      // system audit row, so suites run on the "setting" path production uses. Same id and text.
      await client.query(
        `WITH added AS (
           INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, set_by, approved_by, reason, created_at)
           VALUES ('00000000-0000-4000-8000-000000000503', 500, 300, clock_timestamp(), NULL, NULL,
             'Owner''s decision, 18 Nov 2026: Free 5% and Pro 3% per tip, payment and withdrawal fees included',
             clock_timestamp())
           RETURNING id
         )
         INSERT INTO audit_events (id, staff_user_id, action, permission, subject_type, subject_id, reason, created_at)
         SELECT gen_random_uuid(), NULL, 'plan_fees.changed', 'fees.manage', 'plan_fee_rates', added.id::text,
                'Owner''s decision, 18 Nov 2026: Free 5% and Pro 3% per tip, payment and withdrawal fees included [change: {"from":{"freeBps":"700","proBps":"500"},"to":{"freeBps":"500","proBps":"300"},"approvedBy":null}]',
                clock_timestamp()
           FROM added`,
      );
      // And the business withdrawal fee rule 0130 carries over from the retired switch (fee waivers
      // W15), as on a database where the switch was off: the business pays. Same id and text.
      await client.query(
        `WITH added AS (
           INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at, ends_at,
             reason, set_by, approved_by, created_at)
           VALUES ('00000000-0000-4000-8000-000000000130', 'kind', 'business', NULL, NULL, 'withdrawal',
             'account', clock_timestamp(), NULL, 'Carried over from the switch', NULL, NULL, clock_timestamp())
           RETURNING id, payer
         )
         INSERT INTO audit_events (id, staff_user_id, action, permission, subject_type, subject_id, reason, created_at)
         SELECT gen_random_uuid(), NULL, 'fee_waiver.set', 'fees.manage', 'fee_waiver', added.id::text,
                'Carried over from the switch [change: {"key":"fee_waiver:kind:business:*:withdrawal","from":{"switch":"business_payout_fee_absorbed","on":false},"to":{"payer":"' || added.payer || '","endsAt":null},"approvedBy":null}]',
                clock_timestamp()
           FROM added`,
      );
      // And the launch Business Pro price (Business Pro A1), ₦7,000 a month.
      await client.query(
        `INSERT INTO pro_prices (id, amount_minor, currency, effective_from, plan, reason, created_at)
           VALUES ('00000000-0000-4000-8000-000000700000', 700000, 'NGN', now(), 'business', 'Launch price (owner’s decision, 14 Nov 2026)', now())`,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
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
