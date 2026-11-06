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
  seedManager,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B3: invitations over HTTP. Codes travel in bodies, never URLs; every
// write needs CSRF; a business's invitations are its own managers' only.
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
      RATE_LIMIT_HANDLES_PER_MIN: '1000',
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
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cache: response.headers.get('cache-control'),
  };
};

test('a link invitation: made by a manager, previewed, accepted once, with CSRF on every write', async () => {
  const business = await seedBusiness(database, {
    owner: TOBI.userId,
    locations: [{ slug: 'vi', name: 'Victoria Island' }],
  });
  const path = `/v1/me/businesses/${business.businessId}/invitations`;
  const request = {
    kind: 'staff',
    locationId: business.locations[0].id,
    target: { kind: 'link' },
  };
  // Without CSRF, without a session, or as someone else: refused.
  assert.equal(
    (
      await call('POST', path, {
        cookie: tobi.cookie,
        body: request,
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal((await call('POST', path, { body: request })).status, 401);
  const foreign = await call('POST', path, {
    cookie: ada.cookie,
    body: request,
  });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'BUSINESS_NOT_FOUND');
  const made = await call('POST', path, { cookie: tobi.cookie, body: request });
  assert.equal(made.status, 201);
  assert.equal(made.cache, 'private, no-store');
  const code = made.body.data.link.split('#join=')[1];
  assert.match(code, /^[A-Z2-7]{16}$/);

  // The code is a body field only: there is no route that takes it in a URL.
  const inPath = await call('POST', `/v1/me/work/invitations/${code}/accept`, {
    cookie: ada.cookie,
    body: {},
  });
  assert.equal(inPath.status, 404);
  for (const step of ['preview', 'accept', 'decline'])
    assert.equal(
      (
        await call('POST', `/v1/me/work/invitations/${step}`, {
          cookie: ada.cookie,
          body: { code },
          csrf: false,
        })
      ).status,
      403,
      step,
    );
  const preview = await call('POST', '/v1/me/work/invitations/preview', {
    cookie: ada.cookie,
    body: { code },
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.data, {
    businessName: 'The Yellow Chilli',
    locationName: 'Victoria Island',
    kind: 'staff',
    verified: true,
  });
  const accepted = await call('POST', '/v1/me/work/invitations/accept', {
    cookie: ada.cookie,
    body: { code },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.kind, 'staff');
  const again = await call('POST', '/v1/me/work/invitations/accept', {
    cookie: ada.cookie,
    body: { code },
  });
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'INVITATION_INVALID');
  // A bad shape is a validation error, not a lookup.
  assert.equal(
    (
      await call('POST', '/v1/me/work/invitations/accept', {
        cookie: ada.cookie,
        body: { code: 'lower-case' },
      })
    ).status,
    400,
  );
  // The Work page lists the place; the manager's list shows it accepted.
  const work = await call('GET', '/v1/me/work', { cookie: ada.cookie });
  assert.equal(work.status, 200);
  assert.equal(work.body.data.length, 1);
  assert.equal(work.body.data[0].location.name, 'Victoria Island');
  const list = await call('GET', path, { cookie: tobi.cookie });
  assert.equal(list.body.data[0].state, 'accepted');
  assert.equal(list.body.data[0].target, 'link');
  // Revoking an accepted invitation: the one answer.
  const revoke = await call('POST', `${path}/${made.body.data.id}/revoke`, {
    cookie: tobi.cookie,
    body: {},
  });
  assert.equal(revoke.body.error.code, 'INVITATION_INVALID');
});

test('by username: the search shows only a public card, and the invitation waits on Work', async () => {
  const business = await seedBusiness(database, {
    owner: TOBI.userId,
    name: 'Zed Salon',
  });
  const search = await call(
    'GET',
    `/v1/me/businesses/${business.businessId}/invitees?q=ad`,
    { cookie: tobi.cookie },
  );
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.data, [
    {
      handle: 'ada',
      displayName: ADA.displayName,
      ...(ADA.avatarPath ? { avatarPath: ADA.avatarPath } : {}),
    },
  ]);
  // Nothing private in it, whatever the account holds.
  assert.doesNotMatch(JSON.stringify(search.body), /phone|email|\+234/i);
  assert.equal(
    (
      await call(
        'GET',
        `/v1/me/businesses/${business.businessId}/invitees?q=a`,
        {
          cookie: tobi.cookie,
        },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        'GET',
        `/v1/me/businesses/${business.businessId}/invitees?q=ada`,
        {
          cookie: ada.cookie,
        },
      )
    ).status,
    404,
  );
  const made = await call(
    'POST',
    `/v1/me/businesses/${business.businessId}/invitations`,
    {
      cookie: tobi.cookie,
      body: {
        kind: 'staff',
        locationId: business.locations[0].id,
        target: { kind: 'user', handle: '@Ada' },
      },
    },
  );
  assert.equal(made.status, 201);
  assert.equal(made.body.data.link, undefined);
  const mine = await call('GET', '/v1/me/work/invitations', {
    cookie: ada.cookie,
  });
  const invitation = mine.body.data.invitations.find(
    (i) => i.businessName === 'Zed Salon',
  );
  assert.ok(invitation);
  assert.equal(invitation.id, made.body.data.id);
  // The notification says where to answer.
  const notes = await call('GET', '/v1/me/notifications', {
    cookie: ada.cookie,
  });
  const note = notes.body.data.find(
    (n) => n.invitationId === made.body.data.id,
  );
  assert.equal(note.kind, 'business_invitation');
  assert.equal(note.title, 'Zed Salon invited you');
  // Ada stops this business's invitations; the business is told when it tries again.
  const block = await call(
    'PUT',
    `/v1/me/work/invitation-blocks/${business.businessId}`,
    { cookie: ada.cookie, body: { blocked: true } },
  );
  assert.equal(block.status, 204);
  const refused = await call(
    'POST',
    `/v1/me/businesses/${business.businessId}/invitations`,
    {
      cookie: tobi.cookie,
      body: {
        kind: 'staff',
        locationId: business.locations[0].id,
        target: { kind: 'user', handle: 'ada' },
      },
    },
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'INVITATIONS_BLOCKED');
});

test('only owners invite managers; a location manager invites staff to their location only', async () => {
  const business = await seedBusiness(database, {
    owner: TOBI.userId,
    locations: [{ slug: 'a' }, { slug: 'b' }],
  });
  await seedManager(database, {
    businessId: business.businessId,
    userId: ADA.userId,
    locationId: business.locations[0].id,
  });
  const path = `/v1/me/businesses/${business.businessId}/invitations`;
  const manager = await call('POST', path, {
    cookie: ada.cookie,
    body: { kind: 'manager', role: 'owner', target: { kind: 'link' } },
  });
  assert.equal(manager.status, 403);
  assert.equal(manager.body.error.code, 'OWNER_REQUIRED');
  const elsewhere = await call('POST', path, {
    cookie: ada.cookie,
    body: {
      kind: 'staff',
      locationId: business.locations[1].id,
      target: { kind: 'link' },
    },
  });
  assert.equal(elsewhere.status, 404);
  const own = await call('POST', path, {
    cookie: ada.cookie,
    body: {
      kind: 'staff',
      locationId: business.locations[0].id,
      target: { kind: 'email', email: 'Someone@Example.com' },
    },
  });
  assert.equal(own.status, 201);
  const list = await call('GET', path, { cookie: ada.cookie });
  assert.deepEqual(
    list.body.data.map((row) => [row.target, row.email]),
    [['email', 'someone@example.com']],
  );
});
