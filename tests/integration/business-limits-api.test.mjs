import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { seedBusiness } from '../../packages/database/test/integration/business-fixtures.mjs';
import {
  WEB,
  browserHeaders,
  setSwitch,
  signIn,
  startStack,
} from './helpers.mjs';

// Business Pro, plan Task A4: staff and location limits through the API, only with the
// business_pro switch on. Off, everything is exactly today's.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA] = DEMO_PROFILES;
let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_HANDLES_PER_MIN: '1000',
    },
  });
  await setSwitch(database.pool, 'business', true);
  stack.cookie = (await signIn(stack.api, ADA.phone)).cookie;
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const call = async (stack, method, path, body) => {
  const response = await fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(stack.cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const invite = (stack, business) =>
  call(stack, 'POST', `/v1/me/businesses/${business.businessId}/invitations`, {
    kind: 'staff',
    locationId: business.locations[0].id,
    target: { kind: 'email', email: `${randomUUID()}@example.com` },
  });
const addLocation = (stack, business, slug) =>
  call(stack, 'POST', `/v1/me/businesses/${business.businessId}/locations`, {
    name: 'Ikoyi',
    slug,
    address: '5 Bourdillon, Lagos',
  });

test('switch off: a 5th invite and a 2nd location succeed, and the detail has no plan or usage', async () => {
  await setSwitch(database.pool, 'business_pro', false);
  const off = stack;
  const business = await seedBusiness(database, { owner: ADA.userId });
  for (let n = 0; n < 5; n += 1)
    assert.equal((await invite(off, business)).status, 201);
  const added = await addLocation(off, business, 'ikoyi');
  assert.equal(added.status, 201);
  const detail = await call(
    off,
    'GET',
    `/v1/me/businesses/${business.businessId}`,
  );
  assert.equal(detail.status, 200);
  assert.equal('plan' in detail.body.data, false);
  assert.equal('usage' in detail.body.data, false);
  const release = await (await fetch(`${off.api}/health/release`)).json();
  assert.equal(release.data.businessPro, false);
});

test('switch on: the 4th invite gets 409 BUSINESS_STAFF_LIMIT and the detail shows 3 of 3', async () => {
  await setSwitch(database.pool, 'business_pro', true);
  const on = stack;
  const business = await seedBusiness(database, { owner: ADA.userId });
  for (let n = 0; n < 3; n += 1)
    assert.equal((await invite(on, business)).status, 201);
  const fourth = await invite(on, business);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'BUSINESS_STAFF_LIMIT');
  assert.equal(
    fourth.body.error.message,
    'Your business is at its staff limit.',
  );
  const location = await addLocation(on, business, 'ikoyi');
  assert.equal(location.status, 409);
  assert.equal(location.body.error.code, 'BUSINESS_LOCATION_LIMIT');
  const detail = await call(
    on,
    'GET',
    `/v1/me/businesses/${business.businessId}`,
  );
  assert.equal(detail.body.data.plan, 'free');
  assert.deepEqual(detail.body.data.usage, {
    plan: 'free',
    staff: { used: 3, limit: 3 },
    locations: { used: 1, limit: 1 },
  });
  const release = await (await fetch(`${on.api}/health/release`)).json();
  assert.equal(release.data.businessPro, true);
});
