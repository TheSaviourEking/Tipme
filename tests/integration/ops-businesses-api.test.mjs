import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import {
  payAtBusiness,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// TipMe for businesses, PR B2: the Businesses routes under /v1/ops, with the flag on.

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const REASON = 'Checked the business on a call today';
const [, TOBI] = ops.DEMO_PROFILES;
let database;
let stack;
let owner;
let ownerId;
let searcher;
let plain;
let revalidateServer;
const revalidated = [];

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const idOf = async (phone) =>
  (await q(`SELECT id FROM users WHERE phone_e164 = $1`, [phone]))[0].id;
const roleWith = async (permissions) => {
  const id = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [id]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
  return id;
};

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  revalidateServer = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      revalidated.push(JSON.parse(raw).business);
      response.writeHead(200).end('{}');
    });
  });
  await new Promise((resolve) =>
    revalidateServer.listen(0, '127.0.0.1', resolve),
  );
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
      WEB_REVALIDATE_URL: `http://127.0.0.1:${revalidateServer.address().port}/api/revalidate`,
    },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348037771001');
  ownerId = await idOf('+2348037771001');
  // Staff who may search but not reveal or manage.
  searcher = await opsSignIn(stack.api, database.db, '+2348037771002');
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    await idOf('+2348037771002'),
    await roleWith(['search.view']),
  ]);
  // Staff with neither.
  plain = await opsSignIn(stack.api, database.db, '+2348037771003');
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    await idOf('+2348037771003'),
    await roleWith(['analytics.view']),
  ]);
});
after(async () => {
  await stack?.stop();
  await database?.close();
  revalidateServer?.close();
});
const revalidatedSoon = async (slug) => {
  for (let i = 0; i < 50 && !revalidated.includes(slug); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return revalidated.includes(slug);
};

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});

test('the list masks email and phone; a reveal needs private.view and a reason, and is audited', async () => {
  const { businessId } = await seedBusiness(database, {
    status: 'pending',
    slug: `masked-${randomUUID().slice(0, 6)}`,
  });
  await q(
    `UPDATE businesses SET contact_phone = '+2348039998877' WHERE id = $1`,
    [businessId],
  );
  const list = await json(
    await call('GET', '/v1/ops/businesses?status=pending', searcher.cookie),
  );
  assert.equal(list.status, 200);
  const row = list.body.data.find((entry) => entry.id === businessId);
  assert.equal(row.contactEmailMasked, 'f•••@example.com');
  assert.equal(row.contactPhoneLast4, '8877');
  assert.doesNotMatch(JSON.stringify(list.body), /funke@|2348039998877/);
  const detail = await json(
    await call('GET', `/v1/ops/businesses/${businessId}`, searcher.cookie),
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.locationList.length, 1);
  assert.doesNotMatch(JSON.stringify(detail.body), /funke@|2348039998877/);

  // search.view alone can't reveal.
  const refused = await call(
    'POST',
    `/v1/ops/businesses/${businessId}/reveal`,
    searcher.cookie,
    { reason: REASON },
  );
  assert.equal(refused.status, 403);
  const noReason = await call(
    'POST',
    `/v1/ops/businesses/${businessId}/reveal`,
    owner.cookie,
    {},
  );
  assert.equal(noReason.status, 400);
  const revealed = await json(
    await call(
      'POST',
      `/v1/ops/businesses/${businessId}/reveal`,
      owner.cookie,
      { reason: REASON },
    ),
  );
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.data.contactEmail, 'funke@example.com');
  assert.equal(revealed.body.data.contactPhone, '+2348039998877');
  const audit = await q(
    `SELECT staff_user_id, reason FROM audit_events WHERE action = 'business.reveal' AND subject_id = $1`,
    [businessId],
  );
  assert.deepEqual(audit, [{ staff_user_id: ownerId, reason: REASON }]);
});

test('without search.view the list is 403; non-staff get 404', async () => {
  assert.equal(
    (await call('GET', '/v1/ops/businesses', plain.cookie)).status,
    403,
  );
  const person = await signIn(stack.api, TOBI.phone);
  assert.equal(
    (await call('GET', '/v1/ops/businesses', person.cookie)).status,
    404,
  );
  assert.equal(
    (
      await call(
        'GET',
        '/v1/ops/businesses/00000000-0000-4000-8000-000000000000',
        owner.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (await call('GET', '/v1/ops/businesses?status=nope', owner.cookie)).status,
    400,
  );
});

test('suspend needs businesses.manage and a reason; it ends open shifts and stops attribution', async () => {
  const { businessId, slug, locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
    onShift: true,
  });
  const path = `/v1/ops/businesses/${businessId}/suspend`;
  assert.equal(
    (await call('POST', path, searcher.cookie, { reason: REASON })).status,
    403,
  );
  assert.equal((await call('POST', path, owner.cookie, {})).status, 400);
  const suspended = await json(
    await call('POST', path, owner.cookie, { reason: REASON }),
  );
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  assert.equal(suspended.body.data.status, 'suspended');
  assert.equal(suspended.body.data.suspendedReason, REASON);
  assert.ok(await revalidatedSoon(slug), 'the /b/ pages are refreshed');
  assert.deepEqual(
    await q(`SELECT ended_by FROM business_shifts WHERE member_id = $1`, [
      memberId,
    ]),
    [{ ended_by: 'expired' }],
  );
  const { tipId } = await payAtBusiness(stack.api, {
    handle: 'tobi',
    memberId,
  });
  const [tip] = await q(
    `SELECT profile_id, business_member_id FROM tips WHERE id = $1`,
    [tipId],
  );
  assert.equal(tip.profile_id, TOBI.id, 'the tip still credits the person');
  assert.equal(tip.business_member_id, null, 'and is not attributed');
});

test('restore brings the business back, and attribution with it', async () => {
  const { businessId, locations } = await seedBusiness(database, {
    status: 'suspended',
  });
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
  });
  const restored = await json(
    await call(
      'POST',
      `/v1/ops/businesses/${businessId}/restore`,
      owner.cookie,
      {
        reason: REASON,
      },
    ),
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.status, 'verified');
  assert.equal(restored.body.data.suspendedReason, undefined);
  const { tipId } = await payAtBusiness(stack.api, {
    handle: 'tobi',
    memberId,
  });
  const [tip] = await q(`SELECT business_member_id FROM tips WHERE id = $1`, [
    tipId,
  ]);
  assert.equal(tip.business_member_id, memberId);
});

test('verify through the API: alone it runs and says so; a verified business is refused', async () => {
  const { businessId, slug } = await seedBusiness(database, {
    status: 'pending',
  });
  const path = `/v1/ops/businesses/${businessId}/verify`;
  assert.equal(
    (await call('POST', path, searcher.cookie, { reason: REASON })).status,
    403,
  );
  // Only the owner holds businesses.manage, so nobody else can approve.
  const ran = await json(
    await call('POST', path, owner.cookie, { reason: REASON }),
  );
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.data.status, 'verified');
  assert.equal(ran.body.data.actedAlone, true);
  assert.ok(await revalidatedSoon(slug));
  const again = await json(
    await call('POST', path, owner.cookie, { reason: REASON }),
  );
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, 'VALIDATION_FAILED');
});
