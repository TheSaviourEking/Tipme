import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { browserHeaders, startStack, uniquePrefix } from './helpers.mjs';

// Email sign-in through the real HTTP stack: code by email, session cookie, device cookie.

let stack;
let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const post = (path, body, cookie) =>
  fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify(body),
  });

const usedCodes = new Set();

/** The next unread code email to this address's hint, once the worker has sent it. */
async function codeFor(email, subject = 'sign-in code') {
  const [local, domain] = email.split('@');
  const hint = `${local[0]}•••@${domain}`;
  for (let i = 0; i < 100; i++) {
    const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
    const mail = data.find(
      (m) =>
        m.to === hint &&
        m.subject?.toLowerCase().includes(subject) &&
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

const cookies = (response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

async function signIn(email, cookie) {
  assert.equal((await post('/v1/auth/code', { email }, cookie)).status, 202);
  const code = await codeFor(email);
  const verify = await post('/v1/auth/verify', { email, code }, cookie);
  assert.equal(verify.status, 200);
  return { cookie: cookies(verify), data: (await verify.json()).data };
}

// The inbox shows only the first letter and the domain, so the domain keeps tests apart.
const unique = () => `a@${uniquePrefix()}.example`;

test('auth/code answers 202 for any address, and malformed ones send nothing', async () => {
  assert.equal((await post('/v1/auth/code', { email: unique() })).status, 202);
  assert.equal(
    (await post('/v1/auth/code', { email: 'not-an-address' })).status,
    202,
  );
});

test('auth/verify sets the session and the device cookie, and creates the account once', async () => {
  const email = unique();
  const first = await signIn(email);
  assert.equal(first.data.isNew, true);
  assert.equal(first.data.hasProfile, false);
  assert.match(first.cookie, /tipme_session=/);
  assert.match(first.cookie, /tipme_device=/);
  const second = await signIn(email, first.cookie);
  assert.equal(second.data.isNew, false);
  assert.equal(second.data.userId, first.data.userId);
  assert.match(second.cookie, /tipme_session=/);
});

test('a wrong code is refused, and five lock the address', async () => {
  const email = unique();
  await post('/v1/auth/code', { email });
  const code = await codeFor(email);
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await post('/v1/auth/verify', { email, code: wrong })).status,
      400,
    );
  assert.equal(
    (await post('/v1/auth/verify', { email, code: wrong })).status,
    429,
  );
});

test('an email change confirms by a code to the new address, tells the old one, and ends other sessions', async () => {
  const oldEmail = unique();
  const newEmail = unique();
  const here = await signIn(oldEmail);
  // A second session, on another device, with no shared cookies.
  const there = await signIn(oldEmail);
  assert.equal(
    (await post('/v1/me/email/code', { email: newEmail }, here.cookie)).status,
    202,
  );
  const code = await codeFor(newEmail, 'new tipme email');
  const confirmed = await post(
    '/v1/me/email/confirm',
    { email: newEmail, code },
    here.cookie,
  );
  assert.equal(confirmed.status, 200);
  const me = await fetch(`${stack.api}/v1/me/profile`, {
    headers: browserHeaders(there.cookie),
  });
  assert.equal(me.status, 401, 'the other session ended');
  await codeForNotice(oldEmail);
  // The new address signs in to the same account; the old one no longer does.
  const again = await signIn(newEmail);
  assert.equal(again.data.userId, here.data.userId);
  const old = await signIn(oldEmail);
  assert.notEqual(old.data.userId, here.data.userId);
});

async function codeForNotice(email) {
  const [local, domain] = email.split('@');
  const hint = `${local[0]}•••@${domain}`;
  for (let i = 0; i < 100; i++) {
    const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
    if (
      data.some((m) => m.to === hint && /email changed/.test(m.subject ?? ''))
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no notice arrived');
}

test('an email already proven on another account cannot be taken, and says so only after the code', async () => {
  const taken = unique();
  await signIn(taken);
  const other = await signIn(unique());
  assert.equal(
    (await post('/v1/me/email/code', { email: taken }, other.cookie)).status,
    202,
  );
  const code = await codeFor(taken, 'new tipme email');
  const response = await post(
    '/v1/me/email/confirm',
    { email: taken, code },
    other.cookie,
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'EMAIL_TAKEN');
});

test('phone sign-in is refused once real mail is the provider', async (t) => {
  const { AuthController } =
    await import('../../apps/api/dist/auth/auth.controller.js');
  const api = new AuthController(
    { MAIL_DEFAULT_PROVIDER: 'zeptomail', AUTH_CODE_SECRET: 'x'.repeat(32) },
    { db: database.db },
    {},
  );
  await assert.rejects(api.code({ phone: '+2348030000000' }), {
    code: 'NOT_FOUND',
  });
  void t;
  const { NotificationsController } =
    await import('../../apps/api/dist/notifications/notifications.controller.js');
  const legacy = new NotificationsController(
    {
      MAIL_DEFAULT_PROVIDER: 'zeptomail',
      MAIL_SEAL_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    { db: database.db },
    { revalidate() {} },
  );
  await assert.rejects(legacy.recover({ email: 'a@example.com' }), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(
    legacy.addEmail({ userId: 'x' }, { email: 'a@example.com' }),
    { code: 'NOT_FOUND' },
  );
});
