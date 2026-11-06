import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  seedBusiness,
  seedManager,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B6: check in and out through the API, by the person or a manager, and
// the web revalidation of the business's public pages after each change.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA, TOBI] = DEMO_PROFILES;
let database;
let stack;
let ada;
let tobi;
let revalidateServer;
const revalidations = [];
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  revalidateServer = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      revalidations.push(JSON.parse(raw));
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
      WEB_REVALIDATE_URL: `http://127.0.0.1:${revalidateServer.address().port}/api/revalidate`,
    },
  });
  ada = await signIn(stack.api, ADA.phone);
  tobi = await signIn(stack.api, TOBI.phone);
});
after(async () => {
  await stack.stop();
  await database.close();
  revalidateServer.close();
});

const post = async (path, cookie, headers = browserHeaders(cookie)) => {
  const response = await fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers,
  });
  return { status: response.status, body: await response.json() };
};
const openShifts = async (memberId) =>
  (
    await database.pool.query(
      `SELECT started_by FROM business_shifts WHERE member_id = $1 AND ended_at IS NULL`,
      [memberId],
    )
  ).rows;
/** The revalidation is sent after the answer: wait for it a moment. */
async function revalidatedFor(slug, count) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const seen = revalidations.filter((body) => body.business === slug);
    if (seen.length >= count || Date.now() > deadline) return seen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a person checks in and out at their location; the business pages are refreshed', async () => {
  const business = await seedBusiness(database, { owner: TOBI.userId });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  });

  const start = await post(`/v1/me/work/${memberId}/shift/start`, ada.cookie);
  assert.equal(start.status, 200);
  assert.equal(start.body.data.onShift, true);
  assert.ok(!Number.isNaN(Date.parse(start.body.data.startedAt)));
  assert.equal((await openShifts(memberId)).length, 1);
  const first = await revalidatedFor(business.slug, 1);
  assert.equal(first.length, 1);
  assert.equal(first[0].handle, undefined);
  assert.equal(typeof first[0].secret, 'string');

  // Pressing again changes nothing and refreshes nothing.
  const again = await post(`/v1/me/work/${memberId}/shift/start`, ada.cookie);
  assert.equal(again.body.data.startedAt, start.body.data.startedAt);

  const end = await post(`/v1/me/work/${memberId}/shift/end`, ada.cookie);
  assert.equal(end.status, 200);
  assert.deepEqual(end.body.data, { onShift: false });
  assert.equal((await openShifts(memberId)).length, 0);
  assert.equal((await revalidatedFor(business.slug, 2)).length, 2);
  await post(`/v1/me/work/${memberId}/shift/end`, ada.cookie);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    revalidations.filter((body) => body.business === business.slug).length,
    2,
  );
});

test("someone else's membership, no session, or no CSRF header is refused", async () => {
  const business = await seedBusiness(database, { owner: TOBI.userId });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  });
  const foreign = await post(
    `/v1/me/work/${memberId}/shift/start`,
    tobi.cookie,
  );
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'NOT_FOUND');
  const anonymous = await post(`/v1/me/work/${memberId}/shift/start`);
  assert.equal(anonymous.status, 401);
  const noCsrf = await post(`/v1/me/work/${memberId}/shift/start`, ada.cookie, {
    origin: WEB,
    cookie: ada.cookie,
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await openShifts(memberId)).length, 0);
});

test('a manager checks someone in; a manager of another location cannot (404)', async () => {
  const business = await seedBusiness(database, {
    owner: TOBI.userId,
    locations: [{ slug: 'vi' }, { slug: 'ikoyi' }],
  });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  });
  const path = (verb) =>
    `/v1/me/businesses/${business.businessId}/members/${memberId}/shift/${verb}`;
  const start = await post(path('start'), tobi.cookie);
  assert.equal(start.status, 200);
  assert.deepEqual(await openShifts(memberId), [{ started_by: 'manager' }]);

  // Ada manages the other location only: this member is not hers to change.
  const { managerId } = await seedManager(database, {
    businessId: business.businessId,
    userId: ADA.userId,
    locationId: business.locations[1].id,
  });
  const refused = await post(path('end'), ada.cookie);
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error.code, 'BUSINESS_NOT_FOUND');
  assert.equal((await openShifts(memberId)).length, 1);
  await database.pool.query(
    `UPDATE business_managers SET removed_at = now() WHERE id = $1`,
    [managerId],
  );

  // Another business's id reads like an unknown one.
  const other = await seedBusiness(database, { owner: ADA.userId });
  const elsewhere = await post(
    `/v1/me/businesses/${other.businessId}/members/${memberId}/shift/end`,
    ada.cookie,
  );
  assert.equal(elsewhere.status, 404);
  assert.equal((await openShifts(memberId)).length, 1);

  const end = await post(path('end'), tobi.cookie);
  assert.equal(end.status, 200);
  assert.equal((await openShifts(memberId)).length, 0);
});

test('a paused business refuses a start; a closed location is not found', async () => {
  const paused = await seedBusiness(database, {
    owner: TOBI.userId,
    status: 'suspended',
  });
  const { memberId } = await seedMember(database, {
    locationId: paused.locations[0].id,
    profileId: ADA.id,
  });
  const refused = await post(`/v1/me/work/${memberId}/shift/start`, ada.cookie);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'BUSINESS_NOT_VERIFIED');

  const closed = await seedBusiness(database, {
    owner: TOBI.userId,
    locations: [{ slug: 'vi', closed: true }],
  });
  const { memberId: closedMember } = await seedMember(database, {
    locationId: closed.locations[0].id,
    profileId: ADA.id,
  });
  const gone = await post(
    `/v1/me/work/${closedMember}/shift/start`,
    ada.cookie,
  );
  assert.equal(gone.status, 404);
});

test('two starts at once leave one open shift', async () => {
  const business = await seedBusiness(database, { owner: TOBI.userId });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  });
  const answers = await Promise.all([
    post(`/v1/me/work/${memberId}/shift/start`, ada.cookie),
    post(`/v1/me/work/${memberId}/shift/start`, ada.cookie),
    post(
      `/v1/me/businesses/${business.businessId}/members/${memberId}/shift/start`,
      tobi.cookie,
    ),
  ]);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  );
  assert.equal(new Set(answers.map((a) => a.body.data.startedAt)).size, 1);
  assert.equal((await openShifts(memberId)).length, 1);
});
