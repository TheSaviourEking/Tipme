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
  payAtBusiness,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B0: with BUSINESS_ENABLED off (the default), nothing of it shows.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const ADA = DEMO_PROFILES[0];
let database;
let stack;
let ada;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  // No BUSINESS_ENABLED: the default is off.
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  ada = await signIn(stack.api, ADA.phone);
});
after(async () => {
  await stack.stop();
  await database.close();
});

test('with BUSINESS_ENABLED off, GET /v1/me/business-roles and GET /v1/b/x/y are 404', async () => {
  for (const headers of [{}, { cookie: ada.cookie }]) {
    const roles = await fetch(`${stack.api}/v1/me/business-roles`, { headers });
    assert.equal(roles.status, 404);
    assert.equal((await roles.json()).error.code, 'NOT_FOUND');
  }
  const location = await fetch(`${stack.api}/v1/b/yellow-chilli/vi`);
  assert.equal(location.status, 404);
});

test('with it off, a tip intent carrying businessMemberId is made and not labelled', async () => {
  const { locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: ADA.id,
  });
  const { tipId } = await payAtBusiness(stack.api, { handle: 'ada', memberId });
  const { rows } = await database.pool.query(
    'SELECT profile_id, business_member_id, business_location_id FROM tips WHERE id = $1',
    [tipId],
  );
  assert.deepEqual(rows[0], {
    profile_id: ADA.id,
    business_member_id: null,
    business_location_id: null,
  });
});
