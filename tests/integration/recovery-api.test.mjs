import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { OPS_PERMISSION } from '../../apps/api/dist/ops/ops.guard.js';
import { OpsAccountRecoveryController } from '../../apps/api/dist/ops/account-recovery.controller.js';
import { mailSealing } from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { browserHeaders, startStack, uniquePrefix } from './helpers.mjs';

// Recovery over real HTTP: the routes people use when they can't sign in.

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
const unique = () => `a@${uniquePrefix()}.example`;
const seen = new Set();

async function codeFor(email, subject) {
  const [local, domain] = email.split('@');
  const hint = `${local[0]}•••@${domain}`;
  for (let i = 0; i < 100; i++) {
    const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
    const mail = data.find(
      (m) => m.to === hint && m.subject?.includes(subject) && !seen.has(m.id),
    );
    if (mail) {
      seen.add(mail.id);
      return /\b(\d{6})\b/.exec(mail.body)[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no "${subject}" email arrived`);
}

async function signIn(email) {
  await post('/v1/auth/code', { email });
  const verify = await post('/v1/auth/verify', {
    email,
    code: await codeFor(email, 'sign-in code'),
  });
  assert.equal(verify.status, 200);
  return {
    cookie: verify.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
    userId: (await verify.json()).data.userId,
  };
}

async function withRecovery(email, recovery) {
  const session = await signIn(email);
  assert.equal(
    (
      await post(
        '/v1/me/recovery-email/code',
        { email: recovery },
        session.cookie,
      )
    ).status,
    202,
  );
  const code = await codeFor(recovery, 'recovery email');
  const confirmed = await post(
    '/v1/me/recovery-email',
    { email: recovery, code },
    session.cookie,
  );
  assert.equal(confirmed.status, 200);
  return session;
}

test('every unauthenticated recovery route answers identically for unknown addresses', async () => {
  const start = await post('/v1/auth/email-recovery/start', {
    email: unique(),
  });
  assert.equal(start.status, 202);
  const propose = await post('/v1/auth/email-recovery/propose', {
    email: unique(),
    code: '000000',
    newEmail: unique(),
  });
  const confirm = await post('/v1/auth/email-recovery/confirm', {
    email: unique(),
    newEmail: unique(),
    code: '000000',
  });
  assert.equal(propose.status, 400);
  assert.equal(confirm.status, 400);
  assert.equal((await propose.json()).error.code, 'CODE_INVALID');
  assert.equal((await confirm.json()).error.code, 'CODE_INVALID');
});

test('a person recovers through their recovery email, then cancels from a session', async () => {
  const email = unique();
  const recovery = unique();
  const newEmail = unique();
  const session = await withRecovery(email, recovery);
  const profile = await (
    await fetch(`${stack.api}/v1/me/recovery-email`, {
      headers: browserHeaders(session.cookie),
    })
  ).json();
  assert.equal(profile.data.confirmed, true);
  assert.match(profile.data.hint, /^a•••@/);
  assert.equal(
    (await post('/v1/auth/email-recovery/start', { email })).status,
    202,
  );
  const code = await codeFor(recovery, 'recovery code');
  assert.equal(
    (await post('/v1/auth/email-recovery/propose', { email, code, newEmail }))
      .status,
    202,
  );
  const confirmed = await post('/v1/auth/email-recovery/confirm', {
    email,
    newEmail,
    code: await codeFor(newEmail, 'new TipMe sign-in email'),
  });
  assert.equal(confirmed.status, 200);
  assert.ok((await confirmed.json()).data.effectiveAt);
  const cancelled = await post('/v1/me/recovery/cancel', {}, session.cookie);
  assert.equal((await cancelled.json()).data.cancelled, 1);
});

test('the account’s reminder state and pending recoveries are readable by its owner', async () => {
  const session = await signIn(unique());
  const status = await (
    await fetch(`${stack.api}/v1/me/recovery-email`, {
      headers: browserHeaders(session.cookie),
    })
  ).json();
  assert.deepEqual(status.data, { confirmed: false, hint: null });
});

test('fix: a code that won’t be sent is reported, not claimed', async () => {
  const session = await signIn(unique());
  const ask = (email) =>
    post('/v1/me/recovery-email/code', { email }, session.cookie);
  assert.equal(
    (await (await ask('not-an-email')).json()).error.code,
    'EMAIL_INVALID',
  );
  const busy = unique();
  for (let i = 0; i < 3; i += 1) assert.equal((await ask(busy)).status, 202);
  const fourth = await ask(busy);
  assert.equal(fourth.status, 429);
  assert.equal((await fourth.json()).error.code, 'TOO_MANY_CODES');
});

test('recovery routes are rate limited, and staff recovery names its permission', () => {
  const method = OpsAccountRecoveryController.prototype.startEmailRecovery;
  assert.equal(
    Reflect.getMetadata(OPS_PERMISSION, method),
    'recoveries.manage',
  );
});

test('staff recovery is audited with the checks and refuses a bad account', async () => {
  const { userId } = await signIn(unique());
  const api = new OpsAccountRecoveryController(
    { AUTH_CODE_SECRET: 'integration-auth-code-secret-32-characters' },
    { db: database.db },
    mailSealing(Buffer.alloc(32, 7)),
  );
  const ops = { userId };
  const body = {
    newEmail: unique(),
    checks: 'Matched their last three tips',
    reason: 'Lost access to their email',
  };
  assert.equal(
    (await api.startEmailRecovery(ops, userId, body)).data.outcome,
    'code_sent',
  );
  const { rows } = await database.pool.query(
    `SELECT reason FROM audit_events WHERE action = 'account.staff_recovery_started'`,
  );
  assert.match(rows[0].reason, /Matched their last three tips/);
  await assert.rejects(
    api.startEmailRecovery(ops, '00000000-0000-7000-8000-000000000000', body),
    { code: 'NOT_FOUND' },
  );
});
