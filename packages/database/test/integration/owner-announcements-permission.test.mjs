import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { MIGRATIONS_FOLDER } from '../../dist/migrations.js';
import { useDatabase } from './helpers.mjs';

// ensureOwnerRole runs only when an owner is granted, so an owner made before a permission
// existed never got it. The migration grants announcements.send to the existing owner role (as
// 0098 did for switches.manage), and is safe to run twice.
const TAG = 'owner_announcements_permission';

test('an owner made before the migration gets announcements.send, once', async (t) => {
  const database = await useDatabase(t);
  const name = `tipme_owner_ann_${process.pid}`;
  assert.match(name, /^[a-z_0-9]+$/);
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(database.url);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  pool.on('error', () => undefined);
  const folder = await mkdtemp(join(tmpdir(), 'tipme-migrations-'));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  });
  // The previous release's schema: every migration before this one.
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const mine = journal.entries.findIndex((e) => e.tag.endsWith(TAG));
  assert.ok(mine > 0, `journal lists a migration named ${TAG}`);
  journal.entries = journal.entries.slice(0, mine);
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: folder });

  // The owner role exists before announcements did: it has no announcements.send yet.
  await pool.query(
    `INSERT INTO roles (id, name) VALUES ('owner', 'Owner') ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `DELETE FROM role_permissions WHERE role_id = 'owner' AND permission = 'announcements.send'`,
  );
  const owns = async () =>
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM role_permissions
          WHERE role_id = 'owner' AND permission = 'announcements.send'`,
      )
    ).rows[0].n;
  assert.equal(await owns(), 0);

  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  assert.equal(await owns(), 1);

  // Safe to run twice: the same statement again changes nothing.
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT id, 'announcements.send' FROM roles WHERE id = 'owner'
     ON CONFLICT DO NOTHING`,
  );
  assert.equal(await owns(), 1);
});
