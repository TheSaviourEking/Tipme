import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  leaveMember,
  payAtBusiness,
  seedBusiness,
  seedManager,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B0: GET /v1/me/business-roles with the flag on, and attribution through
// the API.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const sharp = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('sharp');

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
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
  ada = await signIn(stack.api, ADA.phone);
  tobi = await signIn(stack.api, TOBI.phone);
});
after(async () => {
  await stack.stop();
  await database.close();
});

const roles = async (cookie) => {
  const response = await fetch(`${stack.api}/v1/me/business-roles`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, body: await response.json() };
};
const invite = (businessId, locationId, target) =>
  database.pool.query(
    `INSERT INTO business_invitations (id, business_id, location_id, kind, target, email_lower, invited_profile_id, code_sha256, invited_by, expires_at, revoked_at)
     VALUES ($1, $2, $3, 'staff', $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      businessId,
      locationId,
      target.kind,
      target.email ?? null,
      target.profileId ?? null,
      randomUUID(),
      TOBI.userId,
      target.expired
        ? new Date(Date.now() - 1000)
        : new Date(Date.now() + 86_400_000),
      target.revoked ? new Date() : null,
    ],
  );

test('business-roles without a session is 401', async () => {
  const { status, body } = await roles();
  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test("with it on, business-roles lists a manager's business, a member's workplace, and pending invitations", async () => {
  assert.deepEqual((await roles(ada.cookie)).body.data, {
    manages: [],
    works: [],
    invitations: 0,
  });
  const owned = await seedBusiness(database, {
    name: 'Ada Bakes',
    status: 'pending',
  });
  const other = await seedBusiness(database, {
    owner: TOBI.userId,
    name: 'The Yellow Chilli',
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikoyi', name: 'Ikoyi' },
    ],
  });
  await seedManager(database, {
    businessId: other.businessId,
    userId: ADA.userId,
    locationId: other.locations[1].id,
  });
  const { memberId } = await seedMember(database, {
    locationId: other.locations[0].id,
    profileId: ADA.id,
  });
  const third = await seedBusiness(database, {
    owner: TOBI.userId,
    name: 'Zed Salon',
  });
  await invite(third.businessId, third.locations[0].id, {
    kind: 'user',
    profileId: ADA.id,
  });
  // Not counted: revoked, expired, someone else's page, a link, an unproven email.
  await invite(third.businessId, third.locations[0].id, {
    kind: 'user',
    profileId: ADA.id,
    revoked: true,
  });
  await invite(third.businessId, third.locations[0].id, {
    kind: 'user',
    profileId: ADA.id,
    expired: true,
  });
  await invite(third.businessId, third.locations[0].id, {
    kind: 'user',
    profileId: TOBI.id,
  });
  await invite(third.businessId, third.locations[0].id, { kind: 'link' });
  await invite(third.businessId, third.locations[0].id, {
    kind: 'email',
    email: 'nobody@example.com',
  });
  const { status, body } = await roles(ada.cookie);
  assert.equal(status, 200);
  assert.deepEqual(body.data, {
    manages: [
      {
        businessId: owned.businessId,
        slug: owned.slug,
        name: 'Ada Bakes',
        status: 'pending',
        role: 'owner',
        logoPath: null,
      },
      {
        businessId: other.businessId,
        slug: other.slug,
        name: 'The Yellow Chilli',
        status: 'verified',
        role: 'location_manager',
        locationId: other.locations[1].id,
        logoPath: null,
      },
    ],
    works: [
      {
        memberId,
        businessName: 'The Yellow Chilli',
        locationName: 'Victoria Island',
        logoPath: null,
      },
    ],
    invitations: 1,
  });
  // The invited person blocked that business: its invitations stop counting.
  await database.pool.query(
    'INSERT INTO business_invitation_blocks (business_id, user_id) VALUES ($1, $2)',
    [third.businessId, ADA.userId],
  );
  assert.equal((await roles(ada.cookie)).body.data.invitations, 0);
});

test('it never lists a removed manager or a left member', async () => {
  await database.pool.query(
    `UPDATE business_managers SET removed_at = now() WHERE user_id = $1`,
    [ADA.userId],
  );
  const { rows } = await database.pool.query(
    `SELECT bm.id FROM business_members bm WHERE bm.profile_id = $1 AND bm.left_at IS NULL`,
    [ADA.id],
  );
  for (const row of rows) await leaveMember(database, row.id);
  const { body } = await roles(ada.cookie);
  assert.deepEqual(body.data.manages, []);
  assert.deepEqual(body.data.works, []);
});

test('with it on, a tip through the API is labelled with the member and still credits the page', async () => {
  const { locations } = await seedBusiness(database, { owner: TOBI.userId });
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: ADA.id,
  });
  const { tipId } = await payAtBusiness(stack.api, { handle: 'ada', memberId });
  const stray = await payAtBusiness(stack.api, {
    handle: 'ada',
    memberId: randomUUID(),
  });
  const { rows } = await database.pool.query(
    'SELECT id, profile_id, business_member_id, business_location_id FROM tips WHERE id = ANY($1)',
    [[tipId, stray.tipId]],
  );
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId[tipId].business_member_id, memberId);
  assert.equal(byId[tipId].business_location_id, locations[0].id);
  assert.equal(byId[tipId].profile_id, ADA.id);
  assert.equal(byId[stray.tipId].business_member_id, null);
  assert.equal(byId[stray.tipId].profile_id, ADA.id);
});

// The account menu's mark (owner, 16 Nov 2026): each business carries its logo's public address,
// as the page photo's is exposed, so the owner, a manager and a member all see it. Only while the
// business is verified: the public route serves nothing for a waiting or paused one.
test('business-roles carries each business’s public logo address, or null without one', async () => {
  const logo = await sharp({
    create: {
      width: 300,
      height: 300,
      channels: 3,
      background: { r: 15, g: 118, b: 110 },
    },
  })
    .jpeg()
    .toBuffer();
  const upload = (businessId) =>
    fetch(`${stack.api}/v1/me/businesses/${businessId}/logo`, {
      method: 'PUT',
      headers: { ...browserHeaders(ada.cookie), 'content-type': 'image/jpeg' },
      body: logo,
    });
  const withLogo = await seedBusiness(database, {
    owner: ADA.userId,
    name: 'Lagoon Bakery',
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikoyi', name: 'Ikoyi' },
    ],
  });
  const bare = await seedBusiness(database, {
    owner: ADA.userId,
    name: 'Bare Kitchen',
  });
  const waiting = await seedBusiness(database, {
    owner: ADA.userId,
    name: 'Waiting Room Cafe',
    status: 'pending',
  });
  const uploaded = await upload(withLogo.businessId);
  assert.equal(uploaded.status, 200);
  const { logoPath } = (await uploaded.json()).data;
  assert.match(
    logoPath,
    new RegExp(`^/v1/business-logos/${withLogo.businessId}/\\d+\\.webp$`),
  );
  assert.equal((await upload(waiting.businessId)).status, 200);
  // A manager of one location and a member at the other.
  await seedManager(database, {
    businessId: withLogo.businessId,
    userId: TOBI.userId,
    locationId: withLogo.locations[1].id,
  });
  const { memberId } = await seedMember(database, {
    locationId: withLogo.locations[0].id,
    profileId: TOBI.id,
  });

  const owner = (await roles(ada.cookie)).body.data.manages;
  const byName = Object.fromEntries(owner.map((row) => [row.name, row]));
  assert.equal(byName['Lagoon Bakery'].logoPath, logoPath);
  assert.equal(byName['Bare Kitchen'].logoPath, null);
  // Waiting: it has a logo, but its public address doesn't serve it yet.
  assert.equal(byName['Waiting Room Cafe'].logoPath, null);
  assert.equal(
    (await fetch(`${stack.api}${logoPath}`)).status,
    200,
    'the address it sends is the public one, and it serves',
  );

  const staff = (await roles(tobi.cookie)).body.data;
  const managed = staff.manages.find(
    (row) => row.businessId === withLogo.businessId,
  );
  assert.equal(managed.role, 'location_manager');
  assert.equal(managed.logoPath, logoPath);
  assert.deepEqual(
    staff.works.find((row) => row.memberId === memberId),
    {
      memberId,
      businessName: 'Lagoon Bakery',
      locationName: 'Victoria Island',
      logoPath,
    },
  );
  assert.equal(
    staff.manages.find((row) => row.businessId === bare.businessId),
    undefined,
  );
});
