import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import {
  WEB,
  browserHeaders,
  setSwitch,
  signIn,
  startStack,
} from './helpers.mjs';

// Campaign pages over HTTP (plan 2026-11-14 Task 5). One API copy; the campaign_pages switch (admin,
// #216) is on, and the first test turns it off to see today's answers exactly.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let on;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  on = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  await setSwitch(database.pool, 'campaign_pages', true);
});
after(async () => {
  await on.stop();
  await database.close();
});

const ADA_PHONE = '+2348000000001';
let adaSession;
const ada = () => (adaSession ??= signIn(on.api, ADA_PHONE));
const setPlan = (plan) =>
  database.pool.query(
    `UPDATE profiles SET plan = $1 WHERE handle_lower = 'ada'`,
    [plan],
  );
const get = (stack, path, cookie) =>
  fetch(`${stack.api}${path}`, cookie ? { headers: { cookie } } : {});
const send = (stack, method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(cookie),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const page = (over = {}) => ({
  on: true,
  headline: 'Thank you for dancing with me',
  description: 'Saturday at the park.',
  cover: null,
  ...over,
});

let made = 0;
async function newCampaign(stack, cookie) {
  // Stopped campaigns free their place (Free has 1, Pro 20).
  await database.pool.query(
    `UPDATE campaigns SET stopped_at = now() WHERE stopped_at IS NULL
       AND profile_id = (SELECT id FROM profiles WHERE handle_lower = 'ada')`,
  );
  made += 1;
  const response = await send(stack, 'POST', '/v1/me/campaigns', cookie, {
    name: `Lagos Live ${made}`,
    slug: `lagos-${made}`,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).data;
}

test('switch off: the page route is 404 and detail has no page field', async () => {
  await setSwitch(database.pool, 'campaign_pages', false);
  const off = on;
  try {
    await setPlan('pro');
    const { cookie } = await ada();
    const campaign = await newCampaign(off, cookie);
    const detail = await (
      await get(off, `/v1/me/campaigns/${campaign.id}`, cookie)
    ).json();
    assert.equal('page' in detail.data, false);
    assert.equal('pagesAvailable' in detail.data, false);
    // Exactly today's keys.
    assert.deepEqual(Object.keys(detail.data).sort(), [
      'createdAt',
      'displayName',
      'handle',
      'id',
      'name',
      'receivedNetMinor',
      'slug',
      'stoppedAt',
      'tips',
      'visits',
      'weeks',
    ]);
    const list = await (await get(off, '/v1/me/campaigns', cookie)).json();
    assert.equal('pagesAvailable' in list.data, false);
    // Made while switched off: no page, even on Pro.
    const [row] = (
      await database.pool.query(
        `SELECT page_on, headline FROM campaigns WHERE id = $1`,
        [campaign.id],
      )
    ).rows;
    assert.deepEqual(row, { page_on: false, headline: null });
    const save = await send(
      off,
      'PUT',
      `/v1/me/campaigns/${campaign.id}/page`,
      cookie,
      page(),
    );
    assert.equal(save.status, 404);
    const pub = await get(off, `/v1/profiles/ada/campaigns/${campaign.slug}`);
    assert.equal(pub.status, 404);
  } finally {
    await setSwitch(database.pool, 'campaign_pages', true);
  }
});

test('Pro saves a page and the public route returns it', async () => {
  await setPlan('pro');
  const { cookie } = await ada();
  const campaign = await newCampaign(on, cookie);
  const detail = (
    await (await get(on, `/v1/me/campaigns/${campaign.id}`, cookie)).json()
  ).data;
  assert.equal(detail.pagesAvailable, true);
  assert.deepEqual(detail.page, {
    on: true,
    headline: campaign.name,
    description: null,
    cover: null,
  });
  const list = (await (await get(on, '/v1/me/campaigns', cookie)).json()).data;
  assert.equal(list.pagesAvailable, true);

  const save = await send(
    on,
    'PUT',
    `/v1/me/campaigns/${campaign.id}/page`,
    cookie,
    page({
      cover: { design: 'scattered', colour: null },
    }),
  );
  assert.equal(save.status, 200, await save.clone().text());
  assert.equal(
    (await save.json()).data.headline,
    'Thank you for dancing with me',
  );

  const pub = await get(on, `/v1/profiles/ada/campaigns/${campaign.slug}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('cache-control'), 'no-store');
  const body = (await pub.json()).data;
  assert.equal(body.headline, 'Thank you for dancing with me');
  assert.equal(body.description, 'Saturday at the park.');
  assert.equal(body.cover.design, 'scattered');

  // Bad input is refused with the field's words.
  const links = await send(
    on,
    'PUT',
    `/v1/me/campaigns/${campaign.id}/page`,
    cookie,
    page({
      description: 'see tipme.xyz/@ada',
    }),
  );
  assert.equal(links.status, 400);
  const name = await send(
    on,
    'PUT',
    `/v1/me/campaigns/${campaign.id}/page`,
    cookie,
    page({
      headline: 'Thanks from @tobi',
    }),
  );
  assert.equal(name.status, 422);
  assert.equal((await name.json()).error.code, 'CAMPAIGN_HEADLINE_NAME');
  // Someone else's campaign is not found.
  const tobi = await signIn(on.api, '+2348000000002');
  const theirs = await send(
    on,
    'PUT',
    `/v1/me/campaigns/${campaign.id}/page`,
    tobi.cookie,
    page(),
  );
  assert.equal(theirs.status, 404);
});

test('Free gets 403 CAMPAIGN_PRO_REQUIRED', async () => {
  await setPlan('free');
  const { cookie } = await ada();
  const campaign = await newCampaign(on, cookie);
  const detail = (
    await (await get(on, `/v1/me/campaigns/${campaign.id}`, cookie)).json()
  ).data;
  assert.equal(detail.pagesAvailable, false);
  assert.equal(detail.page.on, false);
  const save = await send(
    on,
    'PUT',
    `/v1/me/campaigns/${campaign.id}/page`,
    cookie,
    page(),
  );
  assert.equal(save.status, 403);
  assert.equal((await save.json()).error.code, 'CAMPAIGN_PRO_REQUIRED');
});

test('a stopped campaign’s public route is 404', async () => {
  await setPlan('pro');
  const { cookie } = await ada();
  const campaign = await newCampaign(on, cookie);
  assert.equal(
    (await get(on, `/v1/profiles/ada/campaigns/${campaign.slug}`)).status,
    200,
  );
  const stop = await send(
    on,
    'POST',
    `/v1/me/campaigns/${campaign.id}/stop`,
    cookie,
  );
  assert.equal(stop.status, 200);
  assert.equal(
    (await get(on, `/v1/profiles/ada/campaigns/${campaign.slug}`)).status,
    404,
  );
  assert.equal(
    (await get(on, '/v1/profiles/ada/campaigns/no-such')).status,
    404,
  );
  assert.equal(
    (await get(on, '/v1/profiles/nobody_here/campaigns/x')).status,
    404,
  );
});

test('the public answer has no campaign id, name or results', async () => {
  await setPlan('pro');
  const { cookie } = await ada();
  const campaign = await newCampaign(on, cookie);
  const body = (
    await (await get(on, `/v1/profiles/ada/campaigns/${campaign.slug}`)).json()
  ).data;
  assert.deepEqual(Object.keys(body).sort(), ['headline', 'slug']);
  const text = JSON.stringify(body);
  assert.equal(text.includes(campaign.id), false);
  for (const key of ['id', 'name', 'visits', 'tips', 'receivedNetMinor'])
    assert.equal(key in body, false, key);
});
