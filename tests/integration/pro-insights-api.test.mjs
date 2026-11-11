import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Pro insights over HTTP (pretend payments only): the earnings Pro gate, campaign limits and
// attribution through the public checkout, campaign visits honouring Sec-GPC, and support.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

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
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
      ANALYTICS_ENABLED: 'true',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const sessions = new Map();
const session = (phone) => {
  if (!sessions.has(phone)) sessions.set(phone, signIn(stack.api, phone));
  return sessions.get(phone);
};
const ADA_PHONE = '+2348000000001';
const setPlan = (handle, plan) =>
  database.pool.query('UPDATE profiles SET plan = $2 WHERE handle_lower = $1', [
    handle,
    plan,
  ]);
const get = (path, cookie) =>
  fetch(`${stack.api}${path}`, { headers: { cookie } });
const send = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(cookie),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function tipAda(extra = {}) {
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'ada',
        amountMinor: '300000',
        currency: 'NGN',
      }),
    })
  ).json();
  const key = randomUUID();
  const intentOnce = () =>
    fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ quoteId: quote.data.quoteId, ...extra }),
    });
  const first = await intentOnce();
  assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
  const intent = (await first.json()).data;
  // The page's quiet retry: the same key and body replay the same tip.
  const again = (await (await intentOnce()).json()).data;
  assert.equal(again.tipId, intent.tipId);
  const reference = intent.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
  return intent.tipId;
}

const view = (campaign, headers = {}) =>
  fetch(`${stack.api}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      name: 'profile_viewed',
      flowId: randomUUID(),
      surface: 'profile',
      channel: 'link',
      handle: 'ada',
      ...(campaign ? { campaign } : {}),
    }),
  });

test('earnings: Free gets the basics and 403 for the Pro views; Pro gets them', async () => {
  await setPlan('ada', 'free');
  const { cookie } = await session(ADA_PHONE);
  const basics = await get('/v1/me/earnings', cookie);
  assert.equal(basics.status, 200);
  const summary = (await basics.json()).data;
  assert.equal(summary.currency, 'NGN');
  assert.ok('thisWeek' in summary && 'allTime' in summary);
  for (const path of [
    '/v1/me/earnings/period?period=month&at=2026-10-01',
    '/v1/me/earnings/trend?unit=week',
    '/v1/me/recaps',
  ]) {
    const refused = await get(path, cookie);
    assert.equal(refused.status, 403, path);
    assert.match(
      (await refused.json()).error.code,
      /^(EARNINGS|RECAP)_PRO_REQUIRED$/,
    );
  }
  await setPlan('ada', 'pro');
  const period = await get('/v1/me/earnings/period?period=month', cookie);
  assert.equal(period.status, 200);
  assert.equal((await period.json()).data.byWeekday.length, 7);
  const trend = await get('/v1/me/earnings/trend?unit=month', cookie);
  assert.equal((await trend.json()).data.points.length, 12);
  assert.equal(
    (await get('/v1/me/earnings/period?period=week&at=2999-01-01', cookie))
      .status,
    400,
  );
});

test('campaigns: Free 1, a tip through the link counts once, GPC visits are not counted', async () => {
  await setPlan('ada', 'free');
  const { cookie } = await session(ADA_PHONE);
  const made = await send('POST', '/v1/me/campaigns', cookie, {
    name: '  Saturday   gig ',
    slug: 'saturday-gig',
  });
  assert.equal(made.status, 201);
  const campaign = (await made.json()).data;
  assert.equal(campaign.name, 'Saturday gig');
  const second = await send('POST', '/v1/me/campaigns', cookie, {
    name: 'Another',
    slug: 'another',
  });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'CAMPAIGN_LIMIT');
  const reserved = await send('POST', '/v1/me/campaigns', cookie, {
    name: 'Tobi',
    slug: 'tobi',
  });
  // Free has no room either way; on Pro the ending is refused for being another handle.
  await setPlan('ada', 'pro');
  const asPro = await send('POST', '/v1/me/campaigns', cookie, {
    name: 'Tobi',
    slug: 'tobi',
  });
  assert.equal(reserved.status, 409);
  assert.equal((await asPro.json()).error.code, 'CAMPAIGN_SLUG_UNAVAILABLE');
  const badSlug = await send('POST', '/v1/me/campaigns', cookie, {
    name: 'x',
    slug: 'Bad Slug',
  });
  assert.equal(badSlug.status, 400);

  for (let i = 0; i < 3; i++) await tipAda({ campaign: 'saturday-gig' });
  // A malformed ending is dropped, never a refusal.
  await tipAda({ campaign: 'NOT valid!' });
  assert.equal((await view('saturday-gig')).status, 202);
  assert.equal((await view('saturday-gig', { 'sec-gpc': '1' })).status, 202);
  assert.equal((await view('saturday-gig', { dnt: '1' })).status, 202);

  const list = (await (await get('/v1/me/campaigns', cookie)).json()).data;
  assert.equal(list.handle, 'ada');
  assert.equal(list.limit, 20);
  const row = list.campaigns.find((c) => c.id === campaign.id);
  assert.equal(row.tips, 3);
  assert.equal(row.visits, 1);
  const detail = (
    await (await get(`/v1/me/campaigns/${campaign.id}`, cookie)).json()
  ).data;
  assert.equal(detail.tips, 3);
  assert.equal(detail.displayName.length > 0, true);

  // Another person can't see or stop it.
  const tobi = await session('+2348000000002');
  assert.equal(
    (await get(`/v1/me/campaigns/${campaign.id}`, tobi.cookie)).status,
    404,
  );
  assert.equal(
    (await send('POST', `/v1/me/campaigns/${campaign.id}/stop`, tobi.cookie))
      .status,
    404,
  );
  assert.equal(
    (await send('POST', `/v1/me/campaigns/${campaign.id}/stop`, cookie)).status,
    200,
  );
  // The public page for the campaign shows no campaign name: the tip page API knows none.
  const page = await (await fetch(`${stack.api}/v1/profiles/ada`)).text();
  assert.doesNotMatch(page, /Saturday gig/);
});

test('support: a Pro request gets the Pro line and is priority; words never in the list', async () => {
  await setPlan('ada', 'pro');
  const { cookie } = await session(ADA_PHONE);
  const sent = await send('POST', '/v1/me/support', cookie, {
    topic: 'withdrawal',
    body: 'My withdrawal\u0007 is late',
  });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).data.priority, true);
  const mine = (await (await get('/v1/me/support', cookie)).json()).data;
  assert.equal(mine.proLine, 'Pro requests are answered first.');
  assert.doesNotMatch(JSON.stringify(mine), /late/);
  const { rows } = await database.pool.query(
    'SELECT body FROM support_requests ORDER BY created_at DESC LIMIT 1',
  );
  assert.equal(rows[0].body, 'My withdrawal is late');
  const empty = await send('POST', '/v1/me/support', cookie, {
    topic: 'tip',
    body: '   ',
  });
  assert.equal(empty.status, 400);
  // Without the CSRF header it is refused.
  const noCsrf = await fetch(`${stack.api}/v1/me/support`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: WEB },
    body: JSON.stringify({ topic: 'tip', body: 'x' }),
  });
  assert.equal(noCsrf.status, 403);

  await setPlan('tobi', 'free');
  const tobi = await session('+2348000000002');
  const free = (await (await get('/v1/me/support', tobi.cookie)).json()).data;
  assert.equal(free.proLine, null);
});
