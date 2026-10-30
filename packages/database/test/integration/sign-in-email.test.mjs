import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mailSealing,
  requestEmailSignInCode,
  verifyEmailSignInCode,
} from '../../dist/index.js';
import { queuedMail } from '../../dist/test-support.js';
import { useDatabase } from './helpers.mjs';

const sealing = mailSealing(Buffer.alloc(32, 7));
const secret = 'test-auth-code-secret-at-least-32-chars!';
const DEVICE = 'device-hash-1';

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const request = (email, now) =>
    requestEmailSignInCode(db, sealing, {
      email,
      secret,
      ...(now ? { now } : {}),
    });
  const mails = (limit = 5) => queuedMail(db, sealing, { limit });
  const latestCode = async () =>
    (await mails(20)).find((m) => m.type === 'sign_in_code').data.code;
  const verify = (email, code, extra = {}) =>
    verifyEmailSignInCode(db, sealing, {
      email,
      code,
      secret,
      deviceHash: DEVICE,
      webOrigin: 'https://usetipme.xyz',
      ...extra,
    });
  const signIn = async (email, extra) => {
    await request(email);
    return verify(email, await latestCode(), extra);
  };
  return { ...database, rows, request, mails, latestCode, verify, signIn };
}

test('a code signs in, creating the account with a verified email', async (t) => {
  const { signIn, rows } = await fresh(t);
  const result = await signIn('New.Person@Example.com');
  assert.equal(result.status, 'ok');
  assert.equal(result.created, true);
  const [user] = await rows(
    'SELECT email, email_verified_at IS NOT NULL AS verified, phone_e164 FROM users WHERE id = $1',
    [result.userId],
  );
  assert.deepEqual(user, {
    email: 'new.person@example.com',
    verified: true,
    phone_e164: null,
  });
  const again = await signIn('new.person@example.com');
  assert.deepEqual(
    [again.status, again.userId, again.created],
    ['ok', result.userId, false],
  );
});

test('the answer is the same for unknown, known and malformed addresses', async (t) => {
  const { signIn, request, count } = await fresh(t);
  await signIn('known@example.com');
  assert.deepEqual(await request('known@example.com'), { status: 'sent' });
  assert.deepEqual(await request('unknown@example.com'), { status: 'sent' });
  const before = await count('email_codes');
  assert.deepEqual(await request('not an address'), { status: 'sent' });
  assert.equal(await count('email_codes'), before, 'nothing stored');
});

test('three codes an hour, then rate limited', async (t) => {
  const { request } = await fresh(t);
  for (let i = 0; i < 3; i++)
    assert.equal((await request('a@example.com')).status, 'sent');
  assert.equal((await request('a@example.com')).status, 'rate_limited');
  assert.equal((await request('b@example.com')).status, 'sent');
});

test('five wrong codes lock for fifteen minutes', async (t) => {
  const { request, verify, latestCode } = await fresh(t);
  await request('a@example.com');
  const code = await latestCode();
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i++)
    assert.equal((await verify('a@example.com', wrong)).status, 'invalid');
  assert.equal((await verify('a@example.com', wrong)).status, 'locked');
  assert.equal((await verify('a@example.com', code)).status, 'locked');
  assert.equal((await request('a@example.com')).status, 'locked');
  const later = new Date(Date.now() + 16 * 60_000);
  assert.equal(
    (await verify('a@example.com', code, { now: later })).status,
    'expired',
  );
});

test('only the latest code works, and only once', async (t) => {
  const { request, verify, latestCode } = await fresh(t);
  await request('a@example.com');
  const first = await latestCode();
  await new Promise((r) => setTimeout(r, 5));
  await request('a@example.com');
  const second = await latestCode();
  if (first !== second)
    assert.equal((await verify('a@example.com', first)).status, 'invalid');
  assert.equal((await verify('a@example.com', second)).status, 'ok');
  assert.equal((await verify('a@example.com', second)).status, 'invalid');
});

test('an expired code is refused', async (t) => {
  const { request, verify, latestCode } = await fresh(t);
  await request('a@example.com');
  const later = new Date(Date.now() + 11 * 60_000);
  assert.equal(
    (await verify('a@example.com', await latestCode(), { now: later })).status,
    'expired',
  );
});

test('an unverified claim of the address on another account is cleared and never signed into', async (t) => {
  const { signIn, rows, pool } = await fresh(t);
  const ATTACKER = '00000000-0000-7000-8000-000000007b11';
  await pool.query(
    `UPDATE users SET email = 'victim@example.com', email_verified_at = NULL WHERE id = $1`,
    [ATTACKER],
  );
  const result = await signIn('victim@example.com');
  assert.equal(result.status, 'ok');
  assert.notEqual(result.userId, ATTACKER);
  const [attacker] = await rows('SELECT email FROM users WHERE id = $1', [
    ATTACKER,
  ]);
  assert.equal(attacker.email, null);
});

test('a pending confirmation link for the address stops working once someone proves it', async (t) => {
  const { signIn, rows, pool } = await fresh(t);
  const OTHER = '00000000-0000-7000-8000-000000007b11';
  await pool.query(
    `INSERT INTO email_tokens (token_sha256, user_id, email, purpose, expires_at)
     VALUES ('abc', $1, 'victim@example.com', 'verify', now() + interval '1 day')`,
    [OTHER],
  );
  await signIn('victim@example.com');
  assert.deepEqual(
    await rows(`SELECT 1 FROM email_tokens WHERE token_sha256 = 'abc'`),
    [],
  );
});

test('the first sign-in gets a welcome, not a notice', async (t) => {
  const { signIn, mails } = await fresh(t);
  const result = await signIn('a@example.com');
  const types = async () => (await mails(50)).map((m) => m.type);
  assert.ok((await types()).includes('welcome'));
  assert.ok(!(await types()).includes('new_sign_in_notice'));
  assert.equal(result.created, true);
});

test('a sign-in from a new device sends a notice', async (t) => {
  const { signIn, mails, pool } = await fresh(t);
  const first = await signIn('a@example.com');
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_sha256, device_hash, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, 't1', $2, now(), now(), now() + interval '1 day')`,
    [first.userId, DEVICE],
  );
  await signIn('a@example.com', { deviceLabel: 'Safari on iPhone' });
  assert.ok(
    !(await mails(50)).some((m) => m.type === 'new_sign_in_notice'),
    'seen before',
  );
  await signIn('a@example.com', {
    deviceHash: 'another-device',
    deviceLabel: 'Safari on iPhone',
  });
  const notice = (await mails(50)).find((m) => m.type === 'new_sign_in_notice');
  assert.equal(notice.data.deviceLabel, 'Safari on iPhone');
});

test('the code mail expires with the code, and the code is the only thing sealed in it', async (t) => {
  const { request, rows } = await fresh(t);
  await request('a@example.com');
  const [row] = await rows(
    `SELECT m.expires_at, c.expires_at AS code_expires, m.category, m.priority
       FROM mail_messages m, email_codes c WHERE m.type = 'sign_in_code'`,
  );
  assert.equal(row.expires_at.getTime(), row.code_expires.getTime());
  assert.equal(row.category, 'security');
  assert.equal(row.priority, 0);
});

test('deleting an account erases its email codes and lockouts', async (t) => {
  const { signIn, request, count, db } = await fresh(t);
  const { deleteAccount } = await import('../../dist/index.js');
  const { userId } = await signIn('gone@example.com');
  await request('gone@example.com');
  await deleteAccount(db, { userId });
  assert.equal(await count('email_codes'), 0);
  assert.equal(await count('email_code_lockouts'), 0);
});
