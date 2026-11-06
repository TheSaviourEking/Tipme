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
import {
  seedBusiness,
  seedManager,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B1 Task 6: the business setup routes, through the API.
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
  await database.pool.query(
    `UPDATE users SET email = 'ada@example.com', email_verified_at = now() WHERE id = $1`,
    [ADA.userId],
  );
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

const call = async (method, path, { cookie, body, headers } = {}) => {
  const response = await fetch(`${stack.api}${path}`, {
    method,
    headers: headers ?? browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const application = (slug = `chilli-${randomUUID().slice(0, 8)}`) => ({
  name: 'The Yellow Chilli',
  slug,
  contactName: 'Funke Akindele',
  contactEmail: 'funke@example.com',
  location: {
    name: 'Victoria Island',
    slug: 'vi',
    address: '27 Ademola Adetokunbo, Lagos',
  },
});

test('API: applying makes a pending business the applicant owns; they can read and edit it', async () => {
  const applied = await call('POST', '/v1/me/businesses', {
    cookie: ada.cookie,
    body: application(),
  });
  assert.equal(applied.status, 201);
  const detail = applied.body.data;
  assert.equal(detail.status, 'pending');
  assert.deepEqual(detail.you, { role: 'owner' });

  const read = await call('GET', `/v1/me/businesses/${detail.id}`, {
    cookie: ada.cookie,
  });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, detail);

  const edited = await call('PATCH', `/v1/me/businesses/${detail.id}`, {
    cookie: ada.cookie,
    body: { name: 'Chilli House' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.name, 'Chilli House');

  const added = await call('POST', `/v1/me/businesses/${detail.id}/locations`, {
    cookie: ada.cookie,
    body: { name: 'Ikoyi', slug: 'ikoyi', address: '5 Bourdillon, Lagos' },
  });
  assert.equal(added.status, 201);
  const ikoyi = added.body.data.locations.find((l) => l.slug === 'ikoyi');
  const moved = await call(
    'PATCH',
    `/v1/me/businesses/${detail.id}/locations/${ikoyi.id}`,
    { cookie: ada.cookie, body: { address: '7 Bourdillon, Lagos' } },
  );
  assert.equal(moved.status, 200);
  const closed = await call(
    'POST',
    `/v1/me/businesses/${detail.id}/locations/${ikoyi.id}/close`,
    { cookie: ada.cookie },
  );
  assert.equal(closed.status, 200);
  assert.equal(
    closed.body.data.locations.find((l) => l.id === ikoyi.id).closed,
    true,
  );

  const managers = await call(
    'GET',
    `/v1/me/businesses/${detail.id}/managers`,
    { cookie: ada.cookie },
  );
  assert.equal(managers.status, 200);
  assert.equal(managers.body.data.length, 1);
  assert.equal(managers.body.data[0].you, true);
  const last = await call(
    'POST',
    `/v1/me/businesses/${detail.id}/managers/${managers.body.data[0].managerId}/remove`,
    { cookie: ada.cookie },
  );
  assert.equal(last.status, 409);
  assert.equal(last.body.error.code, 'BUSINESS_LAST_OWNER');
});

test('API: refusals carry the field and the code the form shows', async () => {
  const slug = `taken-${randomUUID().slice(0, 6)}`;
  assert.equal(
    (
      await call('POST', '/v1/me/businesses', {
        cookie: ada.cookie,
        body: application(slug),
      })
    ).status,
    201,
  );
  const taken = await call('POST', '/v1/me/businesses', {
    cookie: ada.cookie,
    body: application(slug),
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'BUSINESS_SLUG_TAKEN');

  const bad = await call('POST', '/v1/me/businesses', {
    cookie: ada.cookie,
    body: { ...application('Not A Slug!'), extra: true },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');

  // `people` is the public search's path (PR B4): no location may take it, at creation or rename.
  const people = await call('POST', '/v1/me/businesses', {
    cookie: ada.cookie,
    body: {
      ...application(),
      location: { ...application().location, slug: 'people' },
    },
  });
  assert.equal(people.status, 400);
  assert.deepEqual(people.body.error.fields, ['location.slug']);
  const mine = (
    await call('POST', '/v1/me/businesses', {
      cookie: ada.cookie,
      body: application(),
    })
  ).body.data;
  const added = await call('POST', `/v1/me/businesses/${mine.id}/locations`, {
    cookie: ada.cookie,
    body: { name: 'People', slug: 'people', address: '1 Broad St, Lagos' },
  });
  assert.equal(added.status, 400);
  assert.deepEqual(added.body.error.fields, ['slug']);
  const renamed = await call(
    'PATCH',
    `/v1/me/businesses/${mine.id}/locations/${mine.locations[0].id}`,
    { cookie: ada.cookie, body: { slug: 'people' } },
  );
  assert.equal(renamed.status, 400);
  assert.deepEqual(renamed.body.error.fields, ['slug']);

  // Tobi has no proven email: applying is refused until they add one.
  const unproven = await call('POST', '/v1/me/businesses', {
    cookie: tobi.cookie,
    body: application(),
  });
  assert.equal(unproven.status, 409);
  assert.equal(unproven.body.error.code, 'EMAIL_VERIFICATION_REQUIRED');
});

test('API: another business id answers 404 exactly like an unknown one; a location manager is held to their location', async () => {
  const theirs = await seedBusiness(database, {
    owner: TOBI.userId,
    locations: [{ slug: 'vi' }, { slug: 'ikoyi' }],
  });
  const unknown = await call('GET', `/v1/me/businesses/${randomUUID()}`, {
    cookie: ada.cookie,
  });
  const foreign = await call('GET', `/v1/me/businesses/${theirs.businessId}`, {
    cookie: ada.cookie,
  });
  assert.equal(unknown.status, 404);
  // Same status, code and words; only the per-request reference differs.
  const plain = ({ status, body }) => ({
    status,
    body: { ...body, error: { ...body.error, reference: undefined } },
  });
  assert.deepEqual(plain(foreign), plain(unknown));
  assert.equal(foreign.body.error.code, 'BUSINESS_NOT_FOUND');

  await seedManager(database, {
    businessId: theirs.businessId,
    userId: ADA.userId,
    locationId: theirs.locations[1].id,
  });
  const seen = await call('GET', `/v1/me/businesses/${theirs.businessId}`, {
    cookie: ada.cookie,
  });
  assert.deepEqual(
    seen.body.data.locations.map((l) => l.slug),
    ['ikoyi'],
  );
  const notMine = await call(
    'PATCH',
    `/v1/me/businesses/${theirs.businessId}/locations/${theirs.locations[0].id}`,
    { cookie: ada.cookie, body: { name: 'x' } },
  );
  assert.equal(notMine.status, 404);
  const addLocation = await call(
    'POST',
    `/v1/me/businesses/${theirs.businessId}/locations`,
    {
      cookie: ada.cookie,
      body: { name: 'Lekki', slug: 'lekki', address: 'Admiralty Way, Lagos' },
    },
  );
  assert.equal(addLocation.status, 403);
  assert.equal(addLocation.body.error.code, 'OWNER_REQUIRED');
  const verified = await call(
    'PATCH',
    `/v1/me/businesses/${theirs.businessId}`,
    { cookie: tobi.cookie, body: { slug: 'brand-new' } },
  );
  assert.equal(verified.status, 409);
  assert.equal(verified.body.error.code, 'SLUG_LOCKED');
});

test('API: every write needs CSRF; reads and writes need a session', async () => {
  const { businessId, locations } = await seedBusiness(database, {
    status: 'pending',
  });
  const writes = [
    ['POST', '/v1/me/businesses', application()],
    ['PATCH', `/v1/me/businesses/${businessId}`, { name: 'x' }],
    [
      'POST',
      `/v1/me/businesses/${businessId}/locations`,
      { name: 'L', slug: 'l2', address: 'A' },
    ],
    [
      'PATCH',
      `/v1/me/businesses/${businessId}/locations/${locations[0].id}`,
      { name: 'x' },
    ],
    [
      'POST',
      `/v1/me/businesses/${businessId}/locations/${locations[0].id}/close`,
    ],
    ['POST', `/v1/me/businesses/${businessId}/managers/${randomUUID()}/remove`],
  ];
  for (const [method, path, body] of writes) {
    const forged = await call(method, path, {
      body,
      headers: {
        'content-type': 'application/json',
        cookie: ada.cookie,
        origin: 'https://evil.example',
      },
    });
    assert.equal(forged.status, 403, `${method} ${path}`);
    assert.equal(forged.body.error.code, 'FORBIDDEN_ORIGIN');
    const anonymous = await call(method, path, { body });
    assert.equal(anonymous.status, 401, `${method} ${path} without a session`);
  }
  for (const path of [
    `/v1/me/businesses/${businessId}`,
    `/v1/me/businesses/${businessId}/managers`,
  ])
    assert.equal((await call('GET', path)).status, 401);
  // Nothing changed.
  const [row] = (
    await database.pool.query(`SELECT name FROM businesses WHERE id = $1`, [
      businessId,
    ])
  ).rows;
  assert.equal(row.name, 'The Yellow Chilli');
});

test('API: applying is rate limited per person', async () => {
  await database.pool.query(
    `UPDATE users SET email = 'tobi@example.com', email_verified_at = now() WHERE id = $1`,
    [TOBI.userId],
  );
  // Tobi's refused application earlier in this file counts too: 10 tries an hour, whatever the
  // answer, so 9 more get through and the next is held back.
  const statuses = [];
  for (let i = 0; i < 10; i++)
    statuses.push(
      (
        await call('POST', '/v1/me/businesses', {
          cookie: tobi.cookie,
          body: application(),
        })
      ).status,
    );
  assert.deepEqual(statuses, [...Array(9).fill(201), 429]);
  // Another person is not held back by Tobi's applications.
  assert.equal(
    (
      await call('POST', '/v1/me/businesses', {
        cookie: ada.cookie,
        body: application(),
      })
    ).status,
    201,
  );
});
