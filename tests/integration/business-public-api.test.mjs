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
  leaveMember,
  payAtBusiness,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, startStack } from './helpers.mjs';

// TipMe for businesses, PR B4 Task 14: the public reads behind a location code and a staff code,
// and a tip whose business label is bad: made, unlabelled, never refused.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA, TOBI] = DEMO_PROFILES;
const SEARCHES_PER_MIN = 5;
let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  // Tobi shares his phone and email on his own page: neither may reach a business page.
  await database.pool.query(
    `UPDATE users SET email = 'tobi@example.com', email_verified_at = now() WHERE id = $1`,
    [TOBI.userId],
  );
  await database.pool.query(
    `UPDATE profiles SET phone_public = true, email_public = true, bio_public = true,
       socials_public = true, links = '[{"url":"https://example.com/tobi"}]'::jsonb WHERE id = $1`,
    [TOBI.id],
  );
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      RATE_LIMIT_BUSINESS_PUBLIC_PER_MIN: String(SEARCHES_PER_MIN),
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const get = async (path) => {
  const response = await fetch(`${stack.api}${path}`, { redirect: 'manual' });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json().catch(() => null),
  };
};

test('API: the location page and the staff page; unknown is 404', async () => {
  const business = await seedBusiness(database, {
    name: 'The Yellow Chilli',
    locations: [{ slug: 'vi', name: 'Victoria Island' }],
  });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: TOBI.id,
    shownName: 'Tobi',
    onShift: true,
  });
  const location = await get(`/v1/b/${business.slug}/vi`);
  assert.equal(location.status, 200);
  assert.deepEqual(location.body.data, {
    business: {
      slug: business.slug,
      name: 'The Yellow Chilli',
      verified: true,
    },
    location: { slug: 'vi', name: 'Victoria Island' },
    people: [
      {
        memberId,
        handle: 'tobi',
        shownName: 'Tobi',
        avatarPath: '/portraits/tobi.webp',
        onShift: true,
      },
    ],
  });
  const staff = await get(`/v1/b/${business.slug}/vi/tobi`);
  assert.equal(staff.status, 200);
  assert.equal(staff.body.data.person.memberId, memberId);
  assert.equal(staff.body.data.profile.displayName, 'Tobi Adeyemi');
  // The pretend provider takes tips on every page.
  assert.equal(staff.body.data.profile.acceptingTips, true);
  assert.equal(staff.body.data.profile.tippingOpen, true);
  assert.equal((await get(`/v1/b/${business.slug}/nowhere`)).status, 404);
  assert.equal((await get(`/v1/b/no-such-place/vi`)).status, 404);
  assert.equal((await get(`/v1/b/${business.slug}/vi/nobody`)).status, 404);
});

test('API: responses carry no display name, bio, phone, email or links', async () => {
  const business = await seedBusiness(database, {
    locations: [{ slug: 'vi' }, { slug: 'ikoyi' }],
  });
  await seedMember(database, {
    locationId: business.locations[1].id,
    profileId: TOBI.id,
    shownName: 'Tobi',
  });
  await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: TOBI.id,
    shownName: 'Tobi',
  });
  const location = JSON.stringify(
    (await get(`/v1/b/${business.slug}/vi`)).body,
  );
  const search = JSON.stringify(
    (await get(`/v1/b/${business.slug}/people?q=tob`)).body,
  );
  const staff = (await get(`/v1/b/${business.slug}/vi/tobi`)).body.data;
  for (const text of [location, search])
    for (const secret of [
      'Adeyemi',
      'Barista',
      'Good coffee',
      TOBI.phone,
      'tobi@example.com',
      'example.com/tobi',
      TOBI.id,
      TOBI.userId,
    ])
      assert.ok(!text.includes(secret), `${secret} in ${text}`);
  // The staff page's tip form needs the person's own name, as their own page shows it; nothing more.
  assert.deepEqual(Object.keys(staff.profile).sort(), [
    'acceptingTips',
    'displayName',
    'handle',
    'plan',
    'tipAmounts',
    'tippingOpen',
  ]);
  const staffText = JSON.stringify(staff);
  for (const secret of [
    'Barista',
    'Good coffee',
    TOBI.phone,
    'tobi@example.com',
    'example.com/tobi',
    TOBI.id,
  ])
    assert.ok(!staffText.includes(secret), secret);
});

test('API: a left member’s staff code answers where to go instead', async () => {
  const business = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  });
  await leaveMember(database, memberId);
  const staff = await get(`/v1/b/${business.slug}/vi/ada`);
  assert.equal(staff.status, 200);
  assert.deepEqual(staff.body.data, { redirectTo: '/@ada' });
});

test('API: a tip whose business label is malformed, foreign or stale is made, unlabelled', async () => {
  const business = await seedBusiness(database);
  const { memberId: tobiMember } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: TOBI.id,
  });
  for (const memberId of ['not-a-uuid', randomUUID(), tobiMember]) {
    // Ada's page with a label that isn't hers, or isn't a label at all.
    const { tipId } = await payAtBusiness(stack.api, {
      handle: 'ada',
      memberId,
    });
    const { rows } = await database.pool.query(
      'SELECT profile_id, business_member_id FROM tips WHERE id = $1',
      [tipId],
    );
    assert.deepEqual(rows[0], { profile_id: ADA.id, business_member_id: null });
  }
  // Not even a string: still a tip.
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'ada',
        amountMinor: '200000',
        currency: 'NGN',
      }),
    })
  ).json();
  const intent = await fetch(`${stack.api}/v1/tip-intents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ quoteId: quote.data.quoteId, businessMemberId: 42 }),
  });
  assert.equal(intent.status, 201);
});

test('API: search is rate-limited per address; the page reads are not', async () => {
  const business = await seedBusiness(database);
  await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: TOBI.id,
    shownName: 'Tobi',
  });
  // A short query is no search, and answers an empty list.
  assert.deepEqual((await get(`/v1/b/${business.slug}/people?q=t`)).body, {
    data: [],
  });
  let limited = 0;
  for (let i = 0; i < SEARCHES_PER_MIN + 2; i += 1) {
    const { status } = await get(`/v1/b/${business.slug}/people?q=to`);
    if (status === 429) limited += 1;
  }
  assert.ok(limited >= 1);
  for (let i = 0; i < SEARCHES_PER_MIN + 2; i += 1)
    assert.equal((await get(`/v1/b/${business.slug}/vi`)).status, 200);
});

test('API: /v1/b/ answers the web app across origins, never with credentials', async () => {
  // A page read, not the search: the test above spent this address's searches.
  const response = await fetch(`${stack.api}/v1/b/no-such/vi`, {
    headers: { origin: WEB },
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), WEB);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  const stranger = await fetch(`${stack.api}/v1/b/no-such/vi`, {
    headers: { origin: 'https://elsewhere.example' },
  });
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);
});
