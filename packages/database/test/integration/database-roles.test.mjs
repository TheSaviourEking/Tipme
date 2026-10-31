import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { applyDatabaseRoles } from '../../dist/roles.js';
import { createDatabase } from '../../dist/client.js';
import { assertLocalDatabaseUrl } from '../../dist/local-only.js';
import { runMigrations } from '../../dist/migrations.js';

// The database roles on a managed Postgres (Aiven): the admin there is not a superuser, only
// CREATEROLE + CREATEDB, owns the database, and may lack REPLICATION. roles.sql must set up the
// runtime, migrator and backup roles from that admin, then migrations run as the migrator.

const base = new URL(
  process.env['DATABASE_URL'] ??
    'postgres://tipme_local:tipme_local_password@127.0.0.1:5432/tipme_local',
);
const suffix = process.pid;
const DB = `tipme_roles_${suffix}`;
const ADMIN = `managed_admin_${suffix}`;
const PASSWORDS = {
  runtime: 'runtime_password_0123456789',
  migrator: 'migrator_password_0123456789',
  backup: 'backup_password_0123456789',
};
const urlAs = (user, password, database = DB) => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

async function asSuperuser(sql, params) {
  const client = new pg.Client({ connectionString: base.toString() });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function query(url, sql, params) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

// Roles are cluster-wide. This test only ever runs against a throwaway local cluster (the
// guard below), where nothing else uses these roles, so it starts and ends without them.
const ROLES = ['tipme_runtime', 'tipme_migrator', 'tipme_backup'];
async function dropTipmeRoles() {
  for (const role of ROLES) await asSuperuser(`DROP ROLE IF EXISTS ${role}`);
}

before(async () => {
  assertLocalDatabaseUrl(base.toString());
  await asSuperuser(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await dropTipmeRoles();
  await asSuperuser(`DROP ROLE IF EXISTS ${ADMIN}`);
  // What Aiven's avnadmin is: no superuser, no replication here (the stricter case).
  await asSuperuser(
    `CREATE ROLE ${ADMIN} LOGIN CREATEROLE CREATEDB NOSUPERUSER NOREPLICATION PASSWORD 'admin_password_0123456789'`,
  );
  await asSuperuser(`CREATE DATABASE ${DB} OWNER ${ADMIN}`);
});

after(async () => {
  await asSuperuser(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await dropTipmeRoles().catch(() => undefined);
  await asSuperuser(`DROP ROLE IF EXISTS ${ADMIN}`).catch(() => undefined);
});

test('a non-superuser admin sets up the roles, the migrator migrates, and each role can do only its job', async () => {
  const admin = urlAs(ADMIN, 'admin_password_0123456789');
  await applyDatabaseRoles({ adminUrl: admin, passwords: PASSWORDS });

  // Migrations run as the migrator, which owns what it creates.
  const migrator = createDatabase(urlAs('tipme_migrator', PASSWORDS.migrator));
  try {
    await runMigrations(migrator.db);
  } finally {
    await migrator.close();
  }
  // Running the roles again after migrating applies the grants on the new tables.
  await applyDatabaseRoles({ adminUrl: admin, passwords: PASSWORDS });

  const runtime = urlAs('tipme_runtime', PASSWORDS.runtime);
  await query(
    runtime,
    `INSERT INTO recovery_markers (id) VALUES (gen_random_uuid())`,
  );
  const { rows } = await query(
    runtime,
    'SELECT count(*)::int AS n FROM recovery_markers',
  );
  assert.equal(rows[0].n, 1, 'the runtime role reads and writes');
  await assert.rejects(
    query(runtime, 'CREATE TABLE nope (id int)'),
    /permission denied/,
    'the runtime role cannot change the schema',
  );

  const backup = urlAs('tipme_backup', PASSWORDS.backup);
  assert.equal(
    (await query(backup, 'SELECT count(*)::int AS n FROM recovery_markers'))
      .rows[0].n,
    1,
    'the backup role reads',
  );
  await assert.rejects(
    query(backup, `DELETE FROM recovery_markers`),
    /permission denied/,
  );

  const replication = (
    await asSuperuser(
      `SELECT rolreplication FROM pg_roles WHERE rolname = 'tipme_backup'`,
    )
  ).rows[0].rolreplication;
  assert.equal(
    replication,
    false,
    'no REPLICATION when the admin cannot grant it',
  );
});

test('running the roles twice changes nothing and fails nothing', async () => {
  const admin = urlAs(ADMIN, 'admin_password_0123456789');
  await applyDatabaseRoles({ adminUrl: admin, passwords: PASSWORDS });
  await applyDatabaseRoles({ adminUrl: admin, passwords: PASSWORDS });
});

test('a password with characters outside letters, digits, - and _ is refused before connecting', async () => {
  await assert.rejects(
    applyDatabaseRoles({
      adminUrl: 'postgres://nobody@127.0.0.1:1/none',
      passwords: { ...PASSWORDS, runtime: "x'; DROP ROLE tipme_backup; --" },
    }),
    /letters, digits/,
  );
});

test('as a superuser (staging), tables it owns move to the migrator and the backup role can replicate', async () => {
  const STAGING_DB = `tipme_roles_su_${suffix}`;
  await asSuperuser(`DROP DATABASE IF EXISTS ${STAGING_DB} WITH (FORCE)`);
  await asSuperuser(`CREATE DATABASE ${STAGING_DB}`);
  try {
    const superUrl = new URL(base);
    superUrl.pathname = `/${STAGING_DB}`;
    // Staging's early tables were created by the superuser itself.
    const owner = createDatabase(superUrl.toString());
    try {
      await runMigrations(owner.db);
    } finally {
      await owner.close();
    }
    await applyDatabaseRoles({
      adminUrl: superUrl.toString(),
      passwords: PASSWORDS,
    });
    const tableOwner = (
      await query(
        superUrl.toString(),
        `SELECT tableowner FROM pg_tables WHERE tablename = 'recovery_markers'`,
      )
    ).rows[0].tableowner;
    assert.equal(tableOwner, 'tipme_migrator');
    const replication = (
      await asSuperuser(
        `SELECT rolreplication FROM pg_roles WHERE rolname = 'tipme_backup'`,
      )
    ).rows[0].rolreplication;
    assert.equal(replication, true);
    await query(
      urlAs('tipme_runtime', PASSWORDS.runtime, STAGING_DB),
      `INSERT INTO recovery_markers (id) VALUES (gen_random_uuid())`,
    );
  } finally {
    await asSuperuser(`DROP DATABASE IF EXISTS ${STAGING_DB} WITH (FORCE)`);
  }
});
