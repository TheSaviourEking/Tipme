import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
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
const inbox = async () =>
  (await (await fetch(`${stack.api}/v1/dev/inbox`)).json()).data;

async function tipTobi(outcome = 'succeed') {
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'tobi',
        amountMinor: '200000',
        currency: 'NGN',
      }),
    })
  ).json();
  const intent = await (
    await fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ quoteId: quote.data.quoteId }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome }),
  });
  return intent.data.tipId;
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out');
}

test('the worker turns a confirmed tip into one notification; a declined tip makes none', async () => {
  const { cookie } = await signIn(stack.api, '+2348000000002');
  const tipId = await tipTobi();
  await tipTobi('decline');
  const list = await waitFor(async () => {
    const data = (
      await (
        await call('GET', '/v1/me/notifications?unreadOnly=1', cookie)
      ).json()
    ).data;
    // The tip, and the moment the worker adds just after it ("Your first tip!").
    return data.some((n) => n.tipId === tipId) &&
      data.some((n) => n.kind === 'moment')
      ? data
      : null;
  });
  assert.equal(list.filter((n) => n.kind === 'tip').length, 1);
  const read = await call('POST', '/v1/me/notifications/read', cookie, {
    ids: list.map((n) => n.id),
  });
  assert.equal(read.status, 204);
  const unread = (
    await (
      await call('GET', '/v1/me/notifications?unreadOnly=1', cookie)
    ).json()
  ).data;
  assert.equal(unread.length, 0);
});

test('email is verified by a link, then phone recovery works through it', async () => {
  const { cookie } = await signIn(stack.api, '+2348000000001');
  assert.equal(
    (await call('POST', '/v1/me/email', cookie, { email: 'ada@example.com' }))
      .status,
    202,
  );
  const link = (await inbox()).find(
    (m) => m.channel === 'email' && /#v=/.test(m.body),
  );
  const token = /#v=([A-Za-z0-9_-]+)/.exec(link.body)[1];
  assert.equal(
    (await call('POST', '/v1/auth/email/confirm', null, { token })).status,
    200,
  );
  const profile = (await (await call('GET', '/v1/me/profile', cookie)).json())
    .data;
  assert.deepEqual(
    [profile.email, profile.emailVerified],
    ['ada@example.com', true],
  );

  assert.equal(
    (await call('POST', '/v1/auth/recover', null, { email: 'ada@example.com' }))
      .status,
    202,
  );
  const recover = (await inbox()).find(
    (m) => m.channel === 'email' && /#r=/.test(m.body),
  );
  const recoveryToken = /#r=([A-Za-z0-9_-]+)/.exec(recover.body)[1];
  assert.equal(
    (
      await call('POST', '/v1/auth/recover/code', null, {
        token: recoveryToken,
        phone: '+2348039990011',
      })
    ).status,
    202,
  );
  const code = /\b(\d{6})\b/.exec((await inbox())[0].body)[1];
  const done = await call('POST', '/v1/auth/recover/complete', null, {
    token: recoveryToken,
    phone: '+2348039990011',
    code,
  });
  // Recovery waits 24 hours (review fix): nobody is signed in yet, and the owner is still in.
  assert.equal(done.status, 202);
  assert.ok((await done.json()).data.pendingUntil);
  assert.equal((await call('GET', '/v1/me/profile', cookie)).status, 200);
  const pending = (await (await call('GET', '/v1/me/recovery', cookie)).json())
    .data;
  assert.equal(pending.length, 1);
  const cancelled = await call('POST', '/v1/me/recovery/cancel', cookie, {});
  assert.equal((await cancelled.json()).data.cancelled, 1);
});

test('a phone change to a number someone else has is refused', async () => {
  const { cookie } = await signIn(stack.api, '+2348031250001');
  await call('POST', '/v1/me/page', cookie, { handle: 'changer' });
  assert.equal(
    (
      await call('POST', '/v1/me/phone/code', cookie, {
        phone: '+2348000000002',
      })
    ).status,
    202,
  );
  const code = /\b(\d{6})\b/.exec((await inbox())[0].body)[1];
  const changed = await call('PUT', '/v1/me/phone', cookie, {
    phone: '+2348000000002',
    code,
  });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, 'PHONE_TAKEN');
});
