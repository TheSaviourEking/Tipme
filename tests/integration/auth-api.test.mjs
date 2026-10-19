import assert from 'node:assert/strict';
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
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const post = (path, body, headers) =>
  fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

test('signing in sets an HttpOnly session cookie and never echoes the number or code', async () => {
  const phone = '+2348031110001';
  const { setCookie, body, cookie } = await signIn(stack.api, phone);
  assert.match(setCookie, /^tipme_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.doesNotMatch(setCookie, /Secure/i);
  assert.equal(body.data.isNew, true);
  assert.equal(body.data.hasProfile, false);
  assert.doesNotMatch(JSON.stringify(body), /8031110001/);
  const logs = JSON.stringify(stack.logs);
  assert.doesNotMatch(logs, /8031110001/);
  const inbox = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
  const code = /\b(\d{6})\b/.exec(inbox.data[0].body)[1];
  assert.equal(logs.includes(code), false);
  const sessions = await fetch(`${stack.api}/v1/me/sessions`, {
    headers: { cookie },
  });
  assert.equal(sessions.status, 200);
  const list = (await sessions.json()).data;
  assert.equal(
    list.some((s) => s.current),
    true,
  );
  assert.equal((await fetch(`${stack.api}/v1/me/sessions`)).status, 401);
});

test('wrong codes are refused, then the number is locked', async () => {
  const phone = '+2348031110002';
  assert.equal(
    (await post('/v1/auth/code', { phone }, browserHeaders())).status,
    202,
  );
  const wrong = async () =>
    post('/v1/auth/verify', { phone, code: '000001' }, browserHeaders());
  const first = await wrong();
  assert.equal(first.status, 400);
  assert.equal((await first.json()).error.code, 'CODE_INVALID');
  for (let i = 0; i < 3; i += 1) await wrong();
  const locked = await wrong();
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error.code, 'SIGN_IN_LOCKED');
});

test('code requests are limited per address', async () => {
  const limited = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '2' },
  });
  try {
    const deadline = Date.now() + 5000;
    while ((await fetch(`${limited.api}/health/ready`)).status !== 200) {
      if (Date.now() > deadline) throw new Error('not ready');
      await new Promise((r) => setTimeout(r, 50));
    }
    const ask = (n) =>
      fetch(`${limited.api}/v1/auth/code`, {
        method: 'POST',
        headers: browserHeaders(),
        body: JSON.stringify({ phone: `+23480311100${n}` }),
      });
    assert.equal((await ask(10)).status, 202);
    assert.equal((await ask(11)).status, 202);
    const refused = await ask(12);
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error.code, 'RATE_LIMITED');
  } finally {
    await limited.stop();
  }
});

test('state-changing requests need the web origin and the CSRF header', async () => {
  const { cookie } = await signIn(stack.api, '+2348031110003');
  const noHeader = await post(
    '/v1/auth/sign-out',
    {},
    { cookie, origin: WEB, 'content-type': 'application/json' },
  );
  assert.equal(noHeader.status, 403);
  assert.equal((await noHeader.json()).error.code, 'FORBIDDEN_ORIGIN');
  const evil = await post(
    '/v1/auth/sign-out',
    {},
    browserHeaders(cookie, { origin: 'https://evil.example' }),
  );
  assert.equal(evil.status, 403);
  assert.equal(
    (await post('/v1/auth/sign-out', {}, browserHeaders(cookie))).status,
    204,
  );
  assert.equal(
    (await fetch(`${stack.api}/v1/me/sessions`, { headers: { cookie } }))
      .status,
    401,
  );
});

test('other sessions can be signed out', async () => {
  const phone = '+2348031110004';
  const one = await signIn(stack.api, phone);
  const two = await signIn(stack.api, phone);
  const out = await post(
    '/v1/me/sessions/sign-out-others',
    {},
    browserHeaders(two.cookie),
  );
  assert.equal(out.status, 204);
  assert.equal(
    (
      await fetch(`${stack.api}/v1/me/sessions`, {
        headers: { cookie: one.cookie },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${stack.api}/v1/me/sessions`, {
        headers: { cookie: two.cookie },
      })
    ).status,
    200,
  );
});

test('auth routes allow credentials only for the web origin; checkout stays without', async () => {
  const preflight = (path, origin) =>
    fetch(`${stack.api}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-tipme-csrf',
      },
    });
  const auth = await preflight('/v1/auth/code', WEB);
  assert.equal(auth.headers.get('access-control-allow-origin'), WEB);
  assert.equal(auth.headers.get('access-control-allow-credentials'), 'true');
  assert.match(
    auth.headers.get('access-control-allow-headers') ?? '',
    /x-tipme-csrf/,
  );
  assert.equal(
    (await preflight('/v1/auth/code', 'https://evil.example')).headers.get(
      'access-control-allow-origin',
    ),
    null,
  );
  const checkout = await preflight('/v1/tip-intents', WEB);
  assert.equal(checkout.headers.get('access-control-allow-credentials'), null);
});
