import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// PUT /v1/me/links (SocialLinks board, owner 5 Nov 2026): the plan's limits hold on the server,
// whatever a browser sends.
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
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response) => (await response.json()).data;

async function livePage(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  assert.equal(
    (await call('POST', '/v1/me/page', cookie, { handle })).status,
    201,
  );
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  return cookie;
}
const plan = (handle, value) =>
  database.pool.query('UPDATE profiles SET plan = $2 WHERE handle_lower = $1', [
    handle,
    value,
  ]);
const put = (cookie, links, show = true) =>
  call('PUT', '/v1/me/links', cookie, { links, show });

const tt = { platform: 'tiktok', url: 'https://www.tiktok.com/@ada.edits' };
const ig = { platform: 'instagram', url: 'https://instagram.com/ada.edits' };
const yt = { platform: 'youtube', url: 'https://youtube.com/@adaedits' };
const tw = { platform: 'twitch', url: 'https://twitch.tv/adaedits' };
const site = { platform: 'website', url: 'https://adaedits.com' };

test('Free: three Free-site links save and show; Pro-only saves are refused with 403', async () => {
  const cookie = await livePage('+2348031280001', 'links_free');
  const saved = await put(cookie, [tt, ig, yt]);
  assert.equal(saved.status, 200);
  assert.deepEqual((await json(saved)).links, [tt, ig, yt]);
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/links_free'))).links,
    [tt, ig, yt],
  );
  for (const links of [
    [tt, ig, yt, tw],
    [site],
    [{ ...tt, featured: true }],
    [ig, tt],
  ]) {
    const refused = await put(cookie, links);
    assert.equal(refused.status, 403);
    const { error } = await refused.json();
    assert.equal(error.code, 'SOCIAL_LINKS_PRO_REQUIRED');
    assert.match(error.message, /TipMe Pro/);
  }
});

test('errors name the field that is wrong, never echoing the value', async () => {
  const cookie = await livePage('+2348031280002', 'links_errors');
  const response = await put(cookie, [
    tt,
    { platform: 'website', url: 'https://linktr.ee/secret-name' },
  ]);
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body).error.fields, ['links.1.url']);
  assert.equal(body.includes('secret-name'), false);
});

test('Pro: 8 links, own order, one featured; when Pro lapses the page shows 3 and keeps the rest', async () => {
  const cookie = await livePage('+2348031280003', 'links_pro');
  await plan('links_pro', 'pro');
  const eight = [
    { ...tw, featured: true },
    tt,
    ig,
    yt,
    site,
    { platform: 'telegram', url: 'https://t.me/adaedits' },
    { platform: 'facebook', url: 'https://facebook.com/ada' },
    { platform: 'fansly', url: 'https://fansly.com/ada' },
  ];
  assert.equal((await put(cookie, eight)).status, 200);
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/links_pro'))).links,
    eight,
  );
  await plan('links_pro', 'free');
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/links_pro'))).links,
    [tw, tt, ig],
  );
  assert.deepEqual(
    (await json(await call('GET', '/v1/me/profile', cookie))).links,
    eight,
  );
});

test('the show switch hides every link from the page', async () => {
  const cookie = await livePage('+2348031280004', 'links_hidden');
  await put(cookie, [tt], false);
  const page = await json(await call('GET', '/v1/profiles/links_hidden'));
  assert.equal('links' in page, false);
  assert.equal('socials' in page, false);
});
