import assert from 'node:assert/strict';
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
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B8: GET /v1/me/businesses/:id/codes through the API.
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
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
  ada = (await signIn(stack.api, ADA.phone)).cookie;
  tobi = (await signIn(stack.api, TOBI.phone)).cookie;
});
after(async () => {
  await stack.stop();
  await database.close();
});

const codes = async (businessId, cookie) => {
  const response = await fetch(
    `${stack.api}/v1/me/businesses/${businessId}/codes`,
    { headers: cookie ? { cookie } : {} },
  );
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.json(),
  };
};

test('codes need a session, and another business reads as unknown', async () => {
  const { businessId } = await seedBusiness(database);
  assert.equal((await codes(businessId)).status, 401);
  const foreign = await codes(businessId, tobi);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'BUSINESS_NOT_FOUND');
});

test('a pending business is refused with BUSINESS_NOT_VERIFIED (M12)', async () => {
  const { businessId } = await seedBusiness(database, { status: 'pending' });
  const answer = await codes(businessId, ada);
  assert.equal(answer.status, 403);
  assert.equal(answer.body.error.code, 'BUSINESS_NOT_VERIFIED');
});

test('a verified business lists its location and staff paths, private and uncached', async () => {
  const { businessId, slug, locations } = await seedBusiness(database);
  await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
  });
  const answer = await codes(businessId, ada);
  assert.equal(answer.status, 200);
  assert.equal(answer.cache, 'private, no-store');
  assert.deepEqual(
    answer.body.data.location.map((entry) => entry.path),
    [`/b/${slug}/vi?src=qr`],
  );
  assert.deepEqual(
    answer.body.data.staff.map((entry) => entry.path),
    [`/b/${slug}/vi/tobi?src=qr`],
  );
});
