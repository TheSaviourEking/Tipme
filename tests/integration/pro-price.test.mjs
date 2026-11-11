import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import {
  MAIL_SEAL_KEY,
  OPS_TOTP_KEY,
  WEB,
  browserHeaders,
  opsSignIn,
  startStack,
} from './helpers.mjs';

// Paid Pro, plan Task 3 (owner, 9 Nov 2026): the price lives on the server, ₦2,500 at launch; staff
// with pro.price change it with a second approver, or alone with an alert when nobody else can.
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Launch offer agreed with the owner today';
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});

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

beforeEach(async () => {
  for (const table of [
    'ops_sessions',
    'staff_totp',
    'staff_permission_overrides',
    'staff',
    'approval_requests',
    'outbox_events',
  ])
    await q(`DELETE FROM ${table}`);
  // Back to the launch price only (the table refuses UPDATE and DELETE; TRUNCATE is test-only).
  await database.reset();
  await ops.ensureOwnerRole(database.db);
});

const people = new Map();
async function person({ roleId = 'owner' } = {}) {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`pp.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [id, roleId],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [id, ops.sealSecret(key, secret)],
  );
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [id, randomBytes(32).toString('hex')],
  );
  const [{ id: grantId }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [id, sessionId, randomBytes(32).toString('hex')],
  );
  people.set(id, { secret, grantId });
  return id;
}

const ask = (actorId, amountMinor) =>
  ops.requestSeriousAction(database.db, {
    name: 'pro_price.change',
    payload: { amountMinor },
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
  });
const approve = (requestId, actorId) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: totpAt(
      people.get(actorId).secret,
      BigInt(Math.floor(Date.now() / 30_000)),
    ),
    key,
    services: services(),
  });
const price = async () =>
  (await ops.currentProPrice(database.db))?.amountMinor ?? null;

test('GET /v1/pro/price returns 250000 NGN a month, cached publicly for 60 seconds', async () => {
  const response = await fetch(`${stack.api}/v1/pro/price`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual((await response.json()).data, {
    amountMinor: '250000',
    currency: 'NGN',
    interval: 'month',
    // This copy runs with PRO_BILLING_ENABLED unset, so buying is not open.
    billingOn: false,
  });
});

test('the launch price is seeded with the owner’s reason', async () => {
  const rows = await q(
    `SELECT amount_minor, currency, set_by, reason FROM pro_prices`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_minor, '250000');
  assert.equal(rows[0].currency, 'NGN');
  assert.equal(rows[0].set_by, null);
  assert.match(rows[0].reason, /Owner's decision, 9 Nov 2026/);
});

test('staff without pro.price get 403 from the price screen’s routes', async () => {
  const phone = `+23480${String(Date.now()).slice(-8)}`;
  const session = await opsSignIn(stack.api, database.db, phone);
  // Take pro.price away from them: a role with everything else.
  const role = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [role]);
  await q(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT $1, permission FROM role_permissions WHERE role_id = 'owner' AND permission <> 'pro.price'`,
    [role],
  );
  await q(
    `UPDATE staff SET role_id = $1 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $2)`,
    [role, phone],
  );
  const read = await fetch(`${stack.api}/v1/ops/pro-price`, {
    headers: browserHeaders(session.cookie),
  });
  assert.equal(read.status, 403);
  const change = await fetch(`${stack.api}/v1/ops/pro-price`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ amountMinor: '300000', reason: REASON }),
  });
  assert.equal(change.status, 403);
});

test('an owner reads the current price and its history', async () => {
  const session = await opsSignIn(
    stack.api,
    database.db,
    `+23481${String(Date.now()).slice(-8)}`,
  );
  const response = await fetch(`${stack.api}/v1/ops/pro-price`, {
    headers: browserHeaders(session.cookie),
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.current.amountMinor, '250000');
  assert.equal(data.history.length, 1);
  assert.equal(data.history[0].setBy, null);
  assert.equal(data.limits.minMinor, '10000');
  assert.equal(data.limits.maxMinor, '100000000');
});

test('a change with a second staff member waits, and the price stays 250000 until approved', async () => {
  const asker = await person();
  await person();
  const outcome = await ask(asker, '300000');
  assert.equal(outcome.state, 'pending');
  const [row] = await q(`SELECT * FROM approval_requests WHERE id = $1`, [
    outcome.requestId,
  ]);
  assert.equal(row.permission, 'pro.price');
  assert.equal(
    row.summary,
    'Change the Pro price from ₦2,500 to ₦3,000 a month, for new months only',
  );
  assert.equal(await price(), 250000n);
});

test('on approval the price is 300000, history has two rows, and the audit names from, to, reason and approver', async () => {
  const asker = await person();
  const approver = await person();
  const { requestId } = await ask(asker, '300000');
  const outcome = await approve(requestId, approver);
  assert.equal(outcome.status, 'approved', JSON.stringify(outcome));
  assert.equal(await price(), 300000n);
  const history = await ops.proPriceHistory(database.db);
  assert.equal(history.length, 2);
  assert.equal(history[0].amountMinor, 300000n);
  assert.equal(history[0].setBy, asker);
  assert.equal(history[0].approvedBy, approver);
  assert.equal(history[0].reason, REASON);
  const [audit] = await q(
    `SELECT staff_user_id, permission, reason FROM audit_events WHERE action = 'pro.price_changed'`,
  );
  assert.equal(audit.staff_user_id, asker);
  assert.equal(audit.permission, 'pro.price');
  assert.ok(audit.reason.startsWith(REASON));
  assert.match(audit.reason, /"from":"250000"/);
  assert.match(audit.reason, /"to":"300000"/);
  assert.match(audit.reason, new RegExp(`"approvedBy":"${approver}"`));
});

test('a lone admin runs it alone, with the acted-alone alert', async () => {
  const lone = await person();
  const outcome = await ask(lone, '300000');
  assert.equal(outcome.state, 'ran');
  assert.equal(outcome.aloneReason, 'no_second_person');
  assert.equal(await price(), 300000n);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    1,
  );
  const [audit] = await q(
    `SELECT reason FROM audit_events WHERE action = 'pro.price_changed'`,
  );
  assert.match(audit.reason, /"approvedBy":null/);
});

test('a request goes stale when the price changed while it waited', async () => {
  const asker = await person();
  const approver = await person();
  const { requestId } = await ask(asker, '300000');
  await q(
    `INSERT INTO pro_prices (id, amount_minor, currency, effective_from, reason, created_at)
     VALUES (gen_random_uuid(), 350000, 'NGN', now(), 'Changed meanwhile for the test', now())`,
  );
  const outcome = await approve(requestId, approver);
  assert.equal(outcome.status, 'stale');
  assert.equal(await price(), 350000n);
});

test('out-of-range, part-naira and unchanged prices are refused INVALID_INPUT', async () => {
  const lone = await person();
  for (const amountMinor of ['9999', '100000100', '250050', '250000', 'abc']) {
    await assert.rejects(
      ask(lone, amountMinor),
      (error) => error.code === 'INVALID_INPUT',
      amountMinor,
    );
  }
  assert.equal(await price(), 250000n);
});

test('pro_prices rows cannot be updated or deleted', async () => {
  await assert.rejects(q(`UPDATE pro_prices SET amount_minor = 1`));
  await assert.rejects(q(`DELETE FROM pro_prices`));
  assert.equal(await price(), 250000n);
});

test('a price set for later is not the current price until then', async () => {
  const now = new Date();
  await q(
    `INSERT INTO pro_prices (id, amount_minor, currency, effective_from, reason, created_at)
     VALUES (gen_random_uuid(), 400000, 'NGN', now() + interval '1 day', 'Future price for the test', now())`,
  );
  assert.equal(
    (await ops.currentProPrice(database.db, now)).amountMinor,
    250000n,
  );
  assert.equal(
    (
      await ops.currentProPrice(
        database.db,
        new Date(now.getTime() + 2 * 86_400_000),
      )
    ).amountMinor,
    400000n,
  );
});
