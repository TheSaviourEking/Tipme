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

// Business release 2, PR R2-C1: the share agreement through the API, with both flags on.
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
      BUSINESS_SHARES_ENABLED: 'true',
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

const call = async (method, path, cookie, body) => {
  const response = await fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text ? JSON.parse(text) : null,
  };
};

async function team() {
  const { businessId, locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
  });
  return { businessId, memberId };
}

test('signed out is 401; another business is 404', async () => {
  const { businessId } = await team();
  assert.equal(
    (await call('GET', `/v1/me/businesses/${businessId}/shares`)).status,
    401,
  );
  assert.equal((await call('GET', '/v1/me/work/shares')).status, 401);
  const other = await call(
    'GET',
    `/v1/me/businesses/${businessId}/shares`,
    tobi.cookie,
  );
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, 'BUSINESS_NOT_FOUND');
});

test('a split outside the options, or over the 50% cap, is a 400', async () => {
  const { businessId, memberId } = await team();
  for (const businessBps of [6000, 1500, '1000', 10000]) {
    const refused = await call(
      'POST',
      `/v1/me/businesses/${businessId}/shares`,
      ada.cookie,
      {
        memberId,
        businessBps,
      },
    );
    assert.equal(refused.status, 400, String(businessBps));
    assert.equal(refused.body.error.code, 'VALIDATION_FAILED');
  }
  const fifty = await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
    {
      memberId,
      businessBps: 5000,
    },
  );
  assert.equal(fifty.status, 201);
  assert.equal(fifty.body.data.state, 'pending');
  assert.equal(fifty.body.data.businessPercent, 50);
  await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares/${fifty.body.data.agreementId}/withdraw`,
    ada.cookie,
  );
});

test('propose, then the staff member accepts on their Work page; a second change this month is refused', async () => {
  const { businessId, memberId } = await team();
  const proposed = await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
    {
      memberId,
      businessBps: 1000,
    },
  );
  assert.equal(proposed.status, 201);
  const mine = await call('GET', '/v1/me/work/shares', tobi.cookie);
  assert.equal(mine.status, 200);
  const offer = mine.body.data.find(
    (v) => v.agreementId === proposed.body.data.agreementId,
  );
  assert.equal(offer.state, 'proposed');
  assert.equal(offer.youKeepPercent, 90);
  assert.equal(offer.businessName, 'The Yellow Chilli');
  // Ada can't answer Tobi's proposal.
  const notHers = await call(
    'POST',
    `/v1/me/work/shares/${offer.agreementId}/accept`,
    ada.cookie,
  );
  assert.equal(notHers.status, 404);
  assert.equal(notHers.body.error.code, 'SHARE_NOT_OPEN');
  const accepted = await call(
    'POST',
    `/v1/me/work/shares/${offer.agreementId}/accept`,
    tobi.cookie,
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.state, 'scheduled');
  const again = await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
    {
      memberId,
      businessBps: 2000,
    },
  );
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SHARE_CHANGE_TOO_SOON');
});

test('a decline reads no_change, and no business response says declined', async () => {
  const { businessId, memberId } = await team();
  const proposed = await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
    {
      memberId,
      businessBps: 2000,
    },
  );
  const declined = await call(
    'POST',
    `/v1/me/work/shares/${proposed.body.data.agreementId}/decline`,
    tobi.cookie,
  );
  assert.equal(declined.status, 204);
  const list = await call(
    'GET',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
  );
  const row = list.body.data.find((r) => r.memberId === memberId);
  assert.deepEqual(row, { memberId, shownName: 'Tobi', state: 'no_change' });
  const withdraw = await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares/${proposed.body.data.agreementId}/withdraw`,
    ada.cookie,
  );
  assert.equal(withdraw.status, 404);
  for (const text of [list.text, withdraw.text])
    assert.doesNotMatch(text, /declin/i);
});

test('the staff member suggests another split and the business accepts it', async () => {
  const { businessId, memberId } = await team();
  const proposed = await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
    {
      memberId,
      businessBps: 3000,
    },
  );
  const counter = await call(
    'POST',
    `/v1/me/work/shares/${proposed.body.data.agreementId}/counter`,
    tobi.cookie,
    { businessBps: 1000 },
  );
  assert.equal(counter.status, 201);
  assert.equal(counter.body.data.proposedBy, 'member');
  const list = await call(
    'GET',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
  );
  const row = list.body.data.find((r) => r.memberId === memberId);
  assert.equal(row.state, 'pending');
  assert.equal(row.proposedBy, 'member');
  assert.equal(row.businessPercent, 10);
  const accepted = await call(
    'POST',
    `/v1/me/businesses/${businessId}/shares/${row.agreementId}/accept`,
    ada.cookie,
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.state, 'in_force');
  assert.equal(accepted.body.data.businessPercent, 10);
});

test('report the business: 204, an issue for TipMe, nothing for the business', async () => {
  const { businessId, memberId } = await team();
  const bad = await call(
    'POST',
    `/v1/me/work/${memberId}/report-business`,
    tobi.cookie,
    {
      reason: 'shouting',
    },
  );
  assert.equal(bad.status, 400);
  const reported = await call(
    'POST',
    `/v1/me/work/${memberId}/report-business`,
    tobi.cookie,
    {
      reason: 'pressure',
      body: 'Told to accept or lose shifts.',
    },
  );
  assert.equal(reported.status, 204);
  const notTheirs = await call(
    'POST',
    `/v1/me/work/${memberId}/report-business`,
    ada.cookie,
    {
      reason: 'other',
    },
  );
  assert.equal(notTheirs.status, 404);
  const { rows } = await database.pool.query(
    `SELECT count(*)::int AS n FROM issues WHERE kind = 'share_report' AND subject->>'businessId' = $1`,
    [businessId],
  );
  assert.equal(rows[0].n, 1);
  const list = await call(
    'GET',
    `/v1/me/businesses/${businessId}/shares`,
    ada.cookie,
  );
  assert.doesNotMatch(list.text, /report|pressure|shifts/i);
});

test('a write without the browser headers is refused', async () => {
  const { businessId, memberId } = await team();
  const response = await fetch(
    `${stack.api}/v1/me/businesses/${businessId}/shares`,
    {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, businessBps: 1000 }),
    },
  );
  assert.equal(response.status, 403);
});

test('with BUSINESS_SHARES_ENABLED off, every share route is 404', async () => {
  const off = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
  try {
    const { businessId, memberId } = await team();
    for (const [method, path] of [
      ['GET', `/v1/me/businesses/${businessId}/shares`],
      ['POST', `/v1/me/businesses/${businessId}/shares`],
      ['GET', '/v1/me/work/shares'],
      ['POST', `/v1/me/work/${memberId}/report-business`],
    ]) {
      const response = await fetch(`${off.api}${path}`, {
        method,
        headers: browserHeaders(ada.cookie),
        ...(method === 'POST'
          ? { body: JSON.stringify({ memberId, businessBps: 1000 }) }
          : {}),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  } finally {
    await off.stop();
  }
});
