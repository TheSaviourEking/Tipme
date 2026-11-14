import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';

// Staff announcements (14 Nov 2026) over HTTP: the screen's calls, and who may make them.
let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const phone = () =>
  `+23481${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

const draft = {
  subject: 'Lower fees on TipMe',
  preheader: 'TipMe’s fee is going down.',
  text: 'From 1 December, the fee is going down.\n\n- **Free: 7%**',
  buttonLabel: 'See the fees',
  buttonUrl: '/pro',
  audience: 'everyone',
};

const call = (session, path, init = {}) =>
  fetch(`${stack.api}/v1/ops/announcements${path}`, {
    ...init,
    headers: browserHeaders(session.cookie),
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

test('the preview is the real email, light and dark, with the settings link', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const response = await call(session, '/preview', {
    method: 'POST',
    body: draft,
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.subject, 'Lower fees on TipMe');
  assert.match(data.html, /prefers-color-scheme: dark/);
  assert.match(data.html, /<strong[^>]*>Free: 7%<\/strong>/);
  assert.match(data.html, />Email settings</);
  assert.match(data.text, /See the fees: http/);
});

test('a draft naming the payment partner is refused at the door', async () => {
  const session = await opsSignIn(stack.api, database.db, phone());
  const response = await call(session, '/preview', {
    method: 'POST',
    body: { ...draft, text: 'Bachs charges ₦50.' },
  });
  assert.equal(response.status, 400);
});

test('write, test, ask: sending waits for a second person (202)', async () => {
  const [{ id: reader }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`news.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO mail_preferences (user_id, marketing) VALUES ($1, true)`,
    [reader],
  );
  const session = await opsSignIn(stack.api, database.db, phone());
  await opsSignIn(stack.api, database.db, phone());
  const created = await call(session, '', { method: 'POST', body: draft });
  assert.equal(created.status, 200);
  const announcement = (await created.json()).data;
  assert.equal(announcement.state, 'draft');
  assert.equal(announcement.audienceCount, 1);

  // The staff member signed in by phone has no email, so the test has nowhere to go.
  const tested = await call(session, `/${announcement.id}/test`, {
    method: 'POST',
  });
  assert.equal(tested.status, 400);

  const asked = await call(session, `/${announcement.id}/send`, {
    method: 'POST',
    body: { reason: 'Telling everyone about the new fees', revision: 1 },
  });
  assert.equal(asked.status, 202);
  assert.ok((await asked.json()).data.requestId);
  const listed = await (await call(session, '')).json();
  assert.equal(
    listed.data.rows.find((row) => row.id === announcement.id).state,
    'waiting',
  );

  const cancelled = await call(session, `/${announcement.id}/cancel`, {
    method: 'POST',
    body: { reason: 'Changed our minds about the date' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).data.state, 'cancelled');
});

test('without announcements.send, every call is refused', async () => {
  const number = phone();
  const session = await opsSignIn(stack.api, database.db, number);
  const role = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [role]);
  await q(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT $1, permission FROM role_permissions WHERE role_id = 'owner' AND permission <> 'announcements.send'`,
    [role],
  );
  await q(
    `UPDATE staff SET role_id = $1 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $2)`,
    [role, number],
  );
  assert.equal((await call(session, '')).status, 403);
  assert.equal(
    (await call(session, '/preview', { method: 'POST', body: draft })).status,
    403,
  );
});
