import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  grantOwner,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
  totpClock,
} from './helpers.mjs';

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

const call = (method, path, cookie, body, headers) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      headers ??
      (method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie)),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const errorCode = async (response) => (await response.json()).error?.code;

test('signed-out visitors and non-staff recipients get 404 on every admin route', async () => {
  const { cookie } = await signIn(stack.api, '+2348036660001');
  for (const [method, path] of [
    ['GET', '/v1/ops/me'],
    ['GET', '/v1/ops/audit'],
    ['POST', '/v1/ops/grant'],
    ['POST', '/v1/ops/enrol'],
  ]) {
    for (const who of [undefined, cookie]) {
      const response = await call(
        method,
        path,
        who,
        method === 'POST' ? { code: '123456' } : undefined,
      );
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(await errorCode(response), 'NOT_FOUND');
    }
  }
});

test('staff without a grant are asked for the authenticator step, and other routes stay hidden', async () => {
  await grantOwner(database.db, { phone: '+2348036660002' });
  const { cookie } = await signIn(stack.api, '+2348036660002');
  const me = await call('GET', '/v1/ops/me', cookie);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).data, { state: 'needs_enrolment' });
  assert.equal((await call('GET', '/v1/ops/audit', cookie)).status, 404);
  const wrongEnrolment = await call('POST', '/v1/ops/enrol', cookie, {
    enrolmentCode: 'AAAAAAAAAA',
  });
  assert.equal(wrongEnrolment.status, 400);
  assert.equal(await errorCode(wrongEnrolment), 'ENROLMENT_INVALID');
});

test('the full flow opens a grant with every Owner permission, and it is audited', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348036660003');
  assert.match(owner.opsCookie, /^tipme_ops=[A-Za-z0-9_-]{43}$/);
  const me = await call('GET', '/v1/ops/me', owner.cookie);
  const data = (await me.json()).data;
  assert.equal(data.state, 'granted');
  assert.equal(data.role, 'owner');
  assert.equal(data.permissions.length, 14);
  const audit = (
    await (await call('GET', '/v1/ops/audit', owner.cookie)).json()
  ).data;
  assert.ok(audit.some((e) => e.action === 'ops.grant_opened'));
  assert.ok(audit.some((e) => e.action === 'ops.authenticator_enrolled'));

  // A later grant needs a fresh code; the same code twice is refused.
  const code = await owner.nextCode();
  const again = await call('POST', '/v1/ops/grant', owner.sessionCookie, {
    code,
  });
  assert.equal(again.status, 200);
  const replay = await call('POST', '/v1/ops/grant', owner.sessionCookie, {
    code,
  });
  assert.equal(replay.status, 400);
  assert.equal(await errorCode(replay), 'CODE_INVALID');
});

test('signing out ends the admin grant, even with the old admin cookie (Review Focus 1)', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348036660004');
  assert.equal((await call('GET', '/v1/ops/audit', owner.cookie)).status, 200);
  assert.equal(
    (await call('POST', '/v1/auth/sign-out', owner.sessionCookie, {})).status,
    204,
  );
  const fresh = await signIn(stack.api, '+2348036660004');
  const replayed = `${fresh.cookie}; ${owner.opsCookie}`;
  assert.equal((await call('GET', '/v1/ops/audit', replayed)).status, 404);
  assert.equal((await call('GET', '/v1/ops/audit', owner.cookie)).status, 404);
  const me = await call('GET', '/v1/ops/me', replayed);
  assert.deepEqual((await me.json()).data, { state: 'needs_code' });
});

test('admin sign-out ends the grant', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348036660005');
  assert.equal(
    (await call('POST', '/v1/ops/sign-out', owner.cookie, {})).status,
    204,
  );
  assert.equal((await call('GET', '/v1/ops/audit', owner.cookie)).status, 404);
});

test('five wrong codes lock admin access: 429 OPS_LOCKED', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348036660006');
  const right = await owner.nextCode();
  const wrong = right === '000000' ? '111111' : '000000';
  const statuses = [];
  for (let i = 0; i < 5; i++)
    statuses.push(
      (
        await call('POST', '/v1/ops/grant', owner.sessionCookie, {
          code: wrong,
        })
      ).status,
    );
  assert.deepEqual(statuses, [400, 400, 400, 400, 429]);
  const locked = await call('POST', '/v1/ops/grant', owner.sessionCookie, {
    code: right,
  });
  assert.equal(locked.status, 429);
  assert.equal(await errorCode(locked), 'OPS_LOCKED');
});

test('staff whose role lacks a permission get 403 FORBIDDEN on that route', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348036660007');
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('viewer', 'Viewer') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('viewer', 'issues.view') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'viewer' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348036660007')`,
  );
  const response = await call('GET', '/v1/ops/audit', owner.cookie);
  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), 'FORBIDDEN');
});

test('state-changing admin routes need the web origin and CSRF header; CORS allows credentials', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348036660008');
  const forged = await call(
    'POST',
    '/v1/ops/sign-out',
    owner.cookie,
    {},
    { 'content-type': 'application/json', cookie: owner.cookie },
  );
  assert.equal(forged.status, 403);
  assert.equal(await errorCode(forged), 'FORBIDDEN_ORIGIN');
  const preflight = await fetch(`${stack.api}/v1/ops/me`, {
    method: 'OPTIONS',
    headers: {
      origin: WEB,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-tipme-csrf',
    },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), WEB);
  assert.equal(
    preflight.headers.get('access-control-allow-credentials'),
    'true',
  );
});

test('totpClock never repeats a step', async () => {
  const next = totpClock('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.notEqual(await next(), await next());
});
