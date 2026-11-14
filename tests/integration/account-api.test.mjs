import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { browserHeaders, startStack, uniquePrefix } from './helpers.mjs';

// Business sign-up, Task D1: a login's own account read (GET /v1/me/account, no page needed) and
// `managesBusiness` on sign-in, which only BUSINESS_SIGNUP_ENABLED turns on.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let on;
let off;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  const env = { RATE_LIMIT_AUTH_PER_HOUR: '1000', BUSINESS_ENABLED: 'true' };
  on = await startStack({
    databaseUrl: database.url,
    apiEnv: { ...env, BUSINESS_SIGNUP_ENABLED: 'true' },
  });
  off = await startStack({ databaseUrl: database.url, apiEnv: env });
});
after(async () => {
  await on?.stop();
  await off?.stop();
  await database?.close();
});

const post = (api, path, body, cookie) =>
  fetch(`${api}${path}`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify(body),
  });

const usedCodes = new Set();
async function codeFor(api, email) {
  const [local, domain] = email.split('@');
  const hint = `${local[0]}•••@${domain}`;
  for (let i = 0; i < 150; i++) {
    const { data } = await (await fetch(`${api}/v1/dev/inbox`)).json();
    const mail = data.find(
      (m) =>
        m.to === hint &&
        m.subject?.toLowerCase().includes('sign-in code') &&
        !usedCodes.has(m.id),
    );
    if (mail) {
      usedCodes.add(mail.id);
      return /\b(\d{6})\b/.exec(mail.body)[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no code arrived');
}

async function signIn(api, email) {
  assert.equal((await post(api, '/v1/auth/code', { email })).status, 202);
  const code = await codeFor(api, email);
  const verify = await post(api, '/v1/auth/verify', { email, code });
  assert.equal(verify.status, 200);
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { cookie, data: (await verify.json()).data };
}

const unique = () => `o@${uniquePrefix()}.example`;
const application = (email) => ({
  name: 'Mama Put Lekki',
  slug: `mama-${randomUUID().slice(0, 8)}`,
  contactName: 'Ngozi Eze',
  contactEmail: email,
  location: {
    name: 'Admiralty Way',
    slug: 'admiralty',
    address: '1 Admiralty Way, Lekki',
  },
});

test('GET /v1/me/account needs a session', async () => {
  const response = await fetch(`${on.api}/v1/me/account`);
  assert.equal(response.status, 401);
});

test('a login with no page reads its own account: email, confirmed, no page', async () => {
  const email = unique();
  const { cookie, data } = await signIn(on.api, email);
  assert.equal(data.hasProfile, false);
  assert.equal(data.managesBusiness, false);
  const response = await fetch(`${on.api}/v1/me/account`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual((await response.json()).data, {
    userId: data.userId,
    email,
    emailVerified: true,
    hasProfile: false,
    handle: null,
  });
});

test('a login with a business and no page signs in with managesBusiness: true', async () => {
  const email = unique();
  const first = await signIn(on.api, email);
  const applied = await post(
    on.api,
    '/v1/me/businesses',
    application(email),
    first.cookie,
  );
  assert.equal(applied.status, 201);
  const again = await signIn(on.api, email);
  assert.equal(again.data.hasProfile, false);
  assert.equal(again.data.managesBusiness, true);
  const account = await fetch(`${on.api}/v1/me/account`, {
    headers: { cookie: again.cookie },
  });
  assert.equal(account.status, 200);
  assert.equal((await account.json()).data.hasProfile, false);
});

test('with BUSINESS_SIGNUP_ENABLED off, managesBusiness is false even for an owner', async () => {
  const email = unique();
  const first = await signIn(off.api, email);
  const applied = await post(
    off.api,
    '/v1/me/businesses',
    application(email),
    first.cookie,
  );
  assert.equal(applied.status, 201);
  const again = await signIn(off.api, email);
  assert.equal(again.data.managesBusiness, false);
});

test('/health/release carries businessSignup and businessOwners', async () => {
  const read = async (api) =>
    (await (await fetch(`${api}/health/release`)).json()).data;
  const yes = await read(on.api);
  assert.equal(yes.businessSignup, true);
  assert.equal(yes.businessOwners, false);
  const no = await read(off.api);
  assert.equal(no.businessSignup, false);
  assert.equal(no.businessOwners, false);
});

// Business sign-up, Task D2: the whole business path through the API, with no page.
test('a login with no page applies, and sees celebrate once after verification', async () => {
  const email = unique();
  const { cookie } = await signIn(on.api, email);
  const applied = await post(
    on.api,
    '/v1/me/businesses',
    { ...application(email), ownerName: 'Ngozi' },
    cookie,
  );
  assert.equal(applied.status, 201);
  const { id } = (await applied.json()).data;
  const detail = async () =>
    (
      await (
        await fetch(`${on.api}/v1/me/businesses/${id}`, { headers: { cookie } })
      ).json()
    ).data;
  assert.deepEqual((await detail()).you, { role: 'owner' });
  await database.pool.query(
    `UPDATE businesses SET status = 'verified', verified_at = now() WHERE id = $1`,
    [id],
  );
  assert.deepEqual((await detail()).you, { role: 'owner', celebrate: true });
  for (let i = 0; i < 2; i++) {
    const seen = await post(
      on.api,
      `/v1/me/businesses/${id}/verified-seen`,
      {},
      cookie,
    );
    assert.equal(seen.status, 204);
  }
  assert.deepEqual((await detail()).you, { role: 'owner' });
  const managers = await (
    await fetch(`${on.api}/v1/me/businesses/${id}/managers`, {
      headers: { cookie },
    })
  ).json();
  assert.deepEqual(
    managers.data.map((m) => m.name),
    ['Ngozi'],
  );
});
