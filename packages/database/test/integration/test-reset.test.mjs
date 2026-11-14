import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { openTestDatabase } from '../../dist/test-support.js';

const waitFor = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
};

// A test file's own worker keeps running while the file resets between tests. Its sweeps read two
// tables in one statement (the take-back sweep joins handle_take_backs to mail_messages), so the
// reset's TRUNCATE, which locks every table in turn, can take one, wait on the other, and be the one
// Postgres cancels (40P01). CI saw exactly that in pro-price.test.mjs. Here the same cycle is made
// on purpose: a reader holds the table the TRUNCATE locks last, then asks for the one it locked first.
test('a reset caught in a deadlock with a running reader tries again and finishes', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  const { rows } = await database.pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const lockedFirst = rows[0].tablename;
  const lockedLast = rows.at(-1).tablename;

  const reader = new pg.Client({ connectionString: database.url });
  await reader.connect();
  t.after(() => reader.end());
  await reader.query('BEGIN');
  await reader.query(`SELECT 1 FROM "${lockedLast}" LIMIT 1`);

  const resetting = database.reset().then(
    () => 'done',
    (error) => error,
  );
  // The TRUNCATE now holds the first tables and waits for the reader's.
  await waitFor(
    async () =>
      (
        await database.pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE 'TRUNCATE%'`,
        )
      ).rows[0].n > 0,
  );
  // Closes the cycle. Whichever side Postgres cancels, the reader finishes its transaction.
  await reader
    .query(`SELECT 1 FROM "${lockedFirst}" LIMIT 1`)
    .catch(() => undefined);
  await reader.query('ROLLBACK');

  const outcome = await resetting;
  assert.equal(outcome, 'done', String(outcome?.code ?? outcome));
  const left = await database.pool.query(
    `SELECT count(*)::int AS n FROM "${lockedLast}"`,
  );
  assert.ok(left.rows[0].n >= 0);
});
