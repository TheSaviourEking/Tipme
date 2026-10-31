import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  dropTestDatabases,
  prepareTestTemplate,
} from '../../dist/test-support.js';

const run = promisify(execFile);
const support = new URL('../../dist/test-support.js', import.meta.url).href;
const TEMPLATE = 'tipme_it_check';

// What one test process sees: its database's name, whether it is migrated, and how many rows a
// shared table holds after it adds one of its own.
const probe = `
  const { openTestDatabase } = await import(${JSON.stringify(support)});
  const database = await openTestDatabase();
  await database.reset();
  await database.pool.query("INSERT INTO analytics_daily (date, metric, dimension, value) VALUES ('2026-10-27', 'probe', '', 1)");
  const name = (await database.pool.query('SELECT current_database() AS n')).rows[0].n;
  const rows = (await database.pool.query('SELECT count(*)::int AS n FROM analytics_daily')).rows[0].n;
  console.log(JSON.stringify({ name, rows }));
  await database.close();
`;

test('test processes each get their own copy of the migrated template, so test files can run in parallel', async (t) => {
  await prepareTestTemplate(TEMPLATE);
  t.after(() => dropTestDatabases(TEMPLATE));
  const env = { ...process.env, TIPME_TEST_TEMPLATE: TEMPLATE };
  const seen = await Promise.all(
    [1, 2].map(async () =>
      JSON.parse(
        (
          await run(process.execPath, ['--input-type=module', '-e', probe], {
            env,
          })
        ).stdout,
      ),
    ),
  );
  assert.notEqual(seen[0].name, seen[1].name);
  for (const { name, rows } of seen) {
    assert.ok(name.startsWith(`${TEMPLATE}_`), name);
    // Migrated (the table exists) and untouched by the other process.
    assert.equal(rows, 1);
  }
});
