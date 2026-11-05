import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { OPS_PERMISSIONS } from '../../packages/contracts/dist/index.js';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  grantOwner,
  seedDemoProfiles,
  staffPermissions,
} from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A signed-in staff member whose role holds exactly these permissions. */
async function staffWith(phone, roleId, permissions) {
  const session = await opsSignIn(stack.api, database.db, phone);
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`,
    [roleId],
  );
  for (const permission of permissions)
    await database.pool.query(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roleId, permission],
    );
  await database.pool.query(
    `UPDATE staff SET role_id = $2 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)`,
    [phone, roleId],
  );
  return session.cookie;
}

const emailRoutes = [
  `/v1/ops/email/messages/${randomUUID()}/timeline`,
  `/v1/ops/email/messages/${randomUUID()}/content`,
  '/v1/ops/email/export.csv?kind=messages',
];
const repairRoutes = [
  '/v1/ops/bachs/checkout-recovery',
  '/v1/ops/bachs/fee-bearer-confirmation',
  '/v1/ops/bachs/account-recovery',
];

test('issues.view alone cannot read email content or export it', async () => {
  const cookie = await staffWith('+2348037770001', 'viewer_only', [
    'issues.view',
  ]);
  for (const path of emailRoutes)
    assert.equal((await call('GET', path, cookie)).status, 403, path);
  // The email.read and email.export permissions open exactly their own routes.
  const reader = await staffWith('+2348037770002', 'email_reader', [
    'email.read',
  ]);
  assert.notEqual((await call('GET', emailRoutes[0], reader)).status, 403);
  assert.notEqual((await call('GET', emailRoutes[1], reader)).status, 403);
  assert.equal((await call('GET', emailRoutes[2], reader)).status, 403);
  const exporter = await staffWith('+2348037770003', 'email_exporter', [
    'email.export',
  ]);
  assert.notEqual((await call('GET', emailRoutes[2], exporter)).status, 403);
  assert.equal((await call('GET', emailRoutes[1], exporter)).status, 403);
});

test('email and provider permissions can open their own screens, and nothing wider', async () => {
  const email = [
    '/v1/ops/email/summary?period=today',
    '/v1/ops/email/series?period=today',
    '/v1/ops/email/messages?period=today',
  ];
  for (const [phone, permission] of [
    ['+2348037770004', 'email.read'],
    ['+2348037770005', 'email.export'],
  ]) {
    const cookie = await staffWith(phone, `only_${phone}`, [permission]);
    for (const path of email)
      assert.equal((await call('GET', path, cookie)).status, 200, path);
    assert.equal(
      (await call('GET', '/v1/ops/providers/mail', cookie)).status,
      403,
    );
  }
  const manager = await staffWith('+2348037770006', 'providers_only', [
    'providers.manage',
  ]);
  assert.equal(
    (await call('GET', '/v1/ops/providers/mail', manager)).status,
    200,
  );
  assert.notEqual(
    (
      await call('POST', '/v1/ops/providers/tests/confirm', manager, {
        token: 'x'.repeat(40),
      })
    ).status,
    403,
  );
  for (const path of email)
    assert.equal((await call('GET', path, manager)).status, 403, path);
  const neither = await staffWith('+2348037770007', 'searcher_only', [
    'search.view',
  ]);
  assert.equal(
    (await call('GET', '/v1/ops/providers/mail', neither)).status,
    403,
  );
  assert.equal((await call('GET', email[0], neither)).status, 403);
});

test('payments.recheck alone cannot run a repair action', async () => {
  const cookie = await staffWith('+2348037770004', 'rechecker', [
    'payments.recheck',
  ]);
  for (const path of repairRoutes)
    assert.equal((await call('POST', path, cookie, {})).status, 403, path);
  // recheck itself still answers to payments.recheck (a bad body is 400, not 403).
  assert.notEqual(
    (await call('POST', '/v1/ops/recheck', cookie, {})).status,
    403,
  );
  const repairer = await staffWith('+2348037770005', 'repairer', [
    'payments.repair',
  ]);
  for (const path of repairRoutes)
    assert.notEqual((await call('POST', path, repairer, {})).status, 403, path);
  assert.equal(
    (await call('POST', '/v1/ops/recheck', repairer, {})).status,
    403,
  );
});

test('owner holds every permission after migrating', async () => {
  // An owner that existed before the migration is topped up by it: replay that step.
  await database.pool.query(
    `DELETE FROM role_permissions WHERE role_id = 'owner' AND permission IN ('email.read','email.export','payments.repair','staff.manage')`,
  );
  const migration = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL(
        '../../packages/database/drizzle/0064_ops_catalogue_permissions.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const insert = migration.slice(migration.indexOf('INSERT INTO'));
  await database.pool.query(insert);
  const { rows } = await database.pool.query(
    `SELECT permission FROM role_permissions WHERE role_id = 'owner'`,
  );
  assert.deepEqual(
    rows.map((r) => r.permission).sort(),
    [...OPS_PERMISSIONS].sort(),
  );
});

test('release_check keeps exactly its four permissions', async () => {
  const { userId } = await grantOwner(database.db, {
    phone: '+2348037770006',
    role: 'release_check',
  });
  assert.deepEqual([...(await staffPermissions(database.db, userId))].sort(), [
    'analytics.view',
    'audit.view',
    'issues.resolve',
    'issues.view',
  ]);
});

test('owner holds usernames.manage after migrating; release_check does not', async () => {
  // An owner that existed before the migration is topped up by it: replay that step.
  await database.pool.query(
    `DELETE FROM role_permissions WHERE role_id = 'owner' AND permission = 'usernames.manage'`,
  );
  const migration = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL(
        '../../packages/database/drizzle/0075_usernames_permission.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  await database.pool.query(migration.slice(migration.indexOf('INSERT INTO')));
  const { rows } = await database.pool.query(
    `SELECT role_id FROM role_permissions WHERE permission = 'usernames.manage' ORDER BY role_id`,
  );
  assert.deepEqual(
    rows.map((r) => r.role_id),
    ['owner'],
  );
  const { userId } = await grantOwner(database.db, {
    phone: '+2348037770016',
    role: 'release_check',
  });
  assert.equal(
    (await staffPermissions(database.db, userId)).has('usernames.manage'),
    false,
  );
});
