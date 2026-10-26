import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let revalidations = [];
let revalidateServer;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  revalidateServer = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      revalidations.push(JSON.parse(raw));
      response.writeHead(200).end('{}');
    });
  });
  await new Promise((resolve) =>
    revalidateServer.listen(0, '127.0.0.1', resolve),
  );
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      WEB_REVALIDATE_URL: `http://127.0.0.1:${revalidateServer.address().port}/api/revalidate`,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
  revalidateServer.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test('sign up, claim a handle, go live, and the web is told to refresh', async () => {
  const { cookie } = await signIn(stack.api, '+2348031240001');
  const free = await call('GET', '/v1/handles/Kemi_api/availability');
  assert.deepEqual((await free.json()).data, {
    handle: 'kemi_api',
    status: 'available',
  });
  const claim = await call('POST', '/v1/me/page', cookie, {
    handle: 'Kemi_api',
  });
  assert.equal(claim.status, 201);
  assert.equal((await call('GET', '/v1/profiles/kemi_api')).status, 404);
  revalidations = [];
  assert.equal(
    (await call('PUT', '/v1/me/page/state', cookie, { state: 'live' })).status,
    200,
  );
  const live = await call('GET', '/v1/profiles/kemi_api');
  assert.equal(live.status, 200);
  assert.equal((await live.json()).data.displayName, 'kemi_api');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    revalidations.map((r) => [r.handle, r.secret]),
    [['kemi_api', 'integration-revalidate-secret-32-characters']],
  );
  const patched = await call('PATCH', '/v1/me/profile', cookie, {
    displayName: 'Kemi',
    socials: { instagram: 'https://evil.example/x' },
  });
  assert.equal(patched.status, 400);
  assert.deepEqual((await patched.json()).error.fields, ['socials.instagram']);
});

test('one recipient can never read or change another', async () => {
  const a = await signIn(stack.api, '+2348031240002');
  const b = await signIn(stack.api, '+2348031240003');
  await call('POST', '/v1/me/page', a.cookie, { handle: 'owner_a' });
  await call('POST', '/v1/me/page', b.cookie, { handle: 'owner_b' });
  await call('PATCH', '/v1/me/profile', b.cookie, { displayName: 'Bee' });
  const mineA = (await (await call('GET', '/v1/me/profile', a.cookie)).json())
    .data;
  assert.equal(mineA.handle, 'owner_a');
  assert.equal(mineA.displayName, 'owner_a');
  assert.equal((await call('GET', '/v1/me/profile')).status, 401);
});

test('a tip quoted while live is refused once the page goes not live', async () => {
  const { cookie } = await signIn(stack.api, '+2348031240004');
  await call('POST', '/v1/me/page', cookie, { handle: 'pausing' });
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'pausing',
        amountMinor: '100000',
        currency: 'NGN',
      }),
    })
  ).json();
  await call('PUT', '/v1/me/page/state', cookie, { state: 'not_live' });
  const intent = await fetch(`${stack.api}/v1/tip-intents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ quoteId: quote.data.quoteId }),
  });
  assert.equal(intent.status, 409);
  assert.equal((await intent.json()).error.code, 'TIP_NOT_PAYABLE');
});

test('deleting needs confirmation and ends the session', async () => {
  const { cookie } = await signIn(stack.api, '+2348031240005');
  await call('POST', '/v1/me/page', cookie, { handle: 'leaving' });
  assert.equal(
    (await call('DELETE', '/v1/me/account', cookie, {})).status,
    400,
  );
  assert.equal(
    (await call('DELETE', '/v1/me/account', cookie, { confirm: 'DELETE' }))
      .status,
    204,
  );
  assert.equal((await call('GET', '/v1/me/profile', cookie)).status, 401);
  assert.deepEqual(
    (await (await call('GET', '/v1/handles/leaving/availability')).json()).data
      .status,
    'taken',
  );
});

test('the seeded demo recipients can sign in to their live pages', async () => {
  const { cookie } = await signIn(stack.api, '+2348000000002');
  const mine = (await (await call('GET', '/v1/me/profile', cookie)).json())
    .data;
  assert.deepEqual(
    [mine.handle, mine.displayName, mine.pageState],
    ['tobi', 'Tobi Adeyemi', 'live'],
  );
  const page = (await (await call('GET', '/v1/profiles/tobi')).json()).data;
  assert.equal(page.role, 'Barista & brightener of mornings');
  assert.equal(page.avatarPath, '/portraits/tobi.webp');
});

test('fix: changing the phone number refreshes the public page', async () => {
  const { cookie } = await signIn(stack.api, '+2348031240091');
  await call('POST', '/v1/me/page', cookie, { handle: 'showsphone' });
  await call('PATCH', '/v1/me/profile', cookie, { phonePublic: true });
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  assert.equal(
    (
      await call('POST', '/v1/me/phone/code', cookie, {
        phone: '+2348031240092',
      })
    ).status,
    202,
  );
  const inbox = (await (await fetch(`${stack.api}/v1/dev/inbox`)).json()).data;
  const code = /\b(\d{6})\b/.exec(
    inbox.find((m) => m.to === '•••0092').body,
  )[1];
  revalidations = [];
  assert.equal(
    (
      await call('PUT', '/v1/me/phone', cookie, {
        phone: '+2348031240092',
        code,
      })
    ).status,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    revalidations.map((r) => r.handle),
    ['showsphone'],
  );
});
