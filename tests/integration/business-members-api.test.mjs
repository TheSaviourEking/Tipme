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
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B3 Task 12: members, leaving, display choices, and deleting an account.
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
  ada = await signIn(stack.api, ADA.phone);
  tobi = await signIn(stack.api, TOBI.phone);
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = async (method, path, { cookie, body, csrf = true } = {}) => {
  const response = await fetch(`${stack.api}${path}`, {
    method,
    headers: csrf
      ? browserHeaders(cookie)
      : { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test('members: listed for the manager, shown as the person chooses, removed or left at once', async () => {
  const business = await seedBusiness(database, { owner: TOBI.userId });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  });
  const members = `/v1/me/businesses/${business.businessId}/members`;
  assert.equal(
    (await call('GET', members, { cookie: ada.cookie })).status,
    404,
  );
  const listed = await call('GET', members, { cookie: tobi.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data[0].memberId, memberId);
  // The person's display choices; CSRF needed.
  assert.equal(
    (
      await call('PATCH', `/v1/me/work/${memberId}`, {
        cookie: ada.cookie,
        body: { shownName: 'Ada O.' },
        csrf: false,
      })
    ).status,
    403,
  );
  const shown = await call('PATCH', `/v1/me/work/${memberId}`, {
    cookie: ada.cookie,
    body: { shownName: 'Ada O.', showPhoto: false },
  });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.data.shownName, 'Ada O.');
  assert.equal(
    (
      await call('PATCH', `/v1/me/work/${memberId}`, {
        cookie: tobi.cookie,
        body: { showPhoto: true },
      })
    ).status,
    404,
  );
  // Removed by the manager: gone from both sides at once.
  assert.equal(
    (
      await call('POST', `${members}/${memberId}/remove`, {
        cookie: tobi.cookie,
        body: {},
      })
    ).status,
    204,
  );
  assert.deepEqual(
    (await call('GET', members, { cookie: tobi.cookie })).body.data,
    [],
  );
  assert.deepEqual(
    (await call('GET', '/v1/me/work', { cookie: ada.cookie })).body.data,
    [],
  );
  // Leaving.
  const second = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  });
  assert.equal(
    (
      await call('POST', `/v1/me/work/${second.memberId}/leave`, {
        cookie: ada.cookie,
        body: {},
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await call('POST', `/v1/me/work/${second.memberId}/leave`, {
        cookie: ada.cookie,
        body: {},
      })
    ).status,
    404,
  );
});

test('deleting the account of a verified business’s only owner is refused with BUSINESS_LAST_OWNER', async () => {
  const response = await call('DELETE', '/v1/me/account', {
    cookie: tobi.cookie,
    body: { confirm: 'DELETE' },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'BUSINESS_LAST_OWNER');
});
