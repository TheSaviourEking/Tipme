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

// The owner, 26 Nov 2026: what a card payment costs TipMe (rate, 3D Secure fixed cost, margin) is an
// ops setting on the Plan fees page, changed like the plan fees: fees.manage, a reason, a fresh code,
// a second person when one exists (or alone with the alert), audited.
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'The partner’s new card price, agreed today';
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});
const DEFAULTS = { rateBps: 200n, fixedMinor: 4500n, marginMinor: 1500n };
const NEXT = { rateBps: 250, fixedMinor: '5000', marginMinor: '2000' };

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
  await stack?.stop();
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
  // The reset empties card_cost_settings: the coded defaults apply.
  await database.reset();
  await ops.ensureOwnerRole(database.db);
});

const people = new Map();
async function person() {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`cc.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [id],
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

const ask = (actorId, payload = NEXT) =>
  ops.requestSeriousAction(database.db, {
    name: 'card_costs.change',
    payload,
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
const cost = () => ops.cardCostAt(database.db, new Date());
const audits = () =>
  q(
    `SELECT staff_user_id, permission, reason FROM audit_events
      WHERE action = 'card_costs.changed' ORDER BY created_at DESC`,
  );

test('staff without fees.manage get 403 from the card cost routes', async () => {
  const phone = `+23486${String(Date.now()).slice(-8)}`;
  const session = await opsSignIn(stack.api, database.db, phone);
  const role = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [role]);
  await q(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT $1, permission FROM role_permissions WHERE role_id = 'owner' AND permission <> 'fees.manage'`,
    [role],
  );
  await q(
    `UPDATE staff SET role_id = $1 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $2)`,
    [role, phone],
  );
  const read = await fetch(`${stack.api}/v1/ops/card-costs`, {
    headers: browserHeaders(session.cookie),
  });
  assert.equal(read.status, 403);
  const change = await fetch(`${stack.api}/v1/ops/card-costs`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ ...NEXT, reason: REASON }),
  });
  assert.equal(change.status, 403);
  assert.deepEqual(await cost(), DEFAULTS);
});

test('an owner reads the defaults, a bad rate is refused 400, and a valid change returns the new cost and its history', async () => {
  const session = await opsSignIn(
    stack.api,
    database.db,
    `+23487${String(Date.now()).slice(-8)}`,
  );
  const read = await fetch(`${stack.api}/v1/ops/card-costs`, {
    headers: browserHeaders(session.cookie),
  });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).data, {
    current: {
      rateBps: 200,
      fixedMinor: '4500',
      marginMinor: '1500',
      source: 'default',
      effectiveFrom: null,
    },
    history: [],
    waitingRequestId: null,
  });
  const bad = await fetch(`${stack.api}/v1/ops/card-costs`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ ...NEXT, rateBps: 10001, reason: REASON }),
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await cost(), DEFAULTS);
  // The only staff member: it runs alone, with the alert.
  const changed = await fetch(`${stack.api}/v1/ops/card-costs`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ ...NEXT, reason: REASON }),
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  const { data } = await changed.json();
  assert.equal(data.actedAlone, true);
  assert.deepEqual(
    { ...data.current, effectiveFrom: typeof data.current.effectiveFrom },
    { ...NEXT, source: 'setting', effectiveFrom: 'string' },
  );
  assert.equal(data.history.length, 1);
  assert.deepEqual(
    {
      rateBps: data.history[0].rateBps,
      fixedMinor: data.history[0].fixedMinor,
      marginMinor: data.history[0].marginMinor,
      reason: data.history[0].reason,
      approvedBy: data.history[0].approvedBy,
    },
    { ...NEXT, reason: REASON, approvedBy: null },
  );
  assert.deepEqual(await cost(), {
    rateBps: 250n,
    fixedMinor: 5000n,
    marginMinor: 2000n,
  });
});

test('a lone admin’s change applies at once, writes an audit row and alerts the owners', async () => {
  const lone = await person();
  const outcome = await ask(lone);
  assert.equal(outcome.state, 'ran');
  assert.equal(outcome.aloneReason, 'no_second_person');
  assert.deepEqual(await cost(), {
    rateBps: 250n,
    fixedMinor: 5000n,
    marginMinor: 2000n,
  });
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    1,
  );
  const [audit] = await audits();
  assert.equal(audit.staff_user_id, lone);
  assert.equal(audit.permission, 'fees.manage');
  assert.ok(audit.reason.startsWith(REASON));
  assert.match(audit.reason, /"approvedBy":null/);
});

test('with a second staff member a change waits for approval, then applies with the approver recorded', async () => {
  const asker = await person();
  const approver = await person();
  const outcome = await ask(asker);
  assert.equal(outcome.state, 'pending');
  const [row] = await q(`SELECT * FROM approval_requests WHERE id = $1`, [
    outcome.requestId,
  ]);
  assert.equal(row.permission, 'fees.manage');
  assert.equal(
    row.summary,
    'Change the card cost from 2% + ₦45, margin ₦15 to 2.5% + ₦50, margin ₦20, for new checkouts only',
  );
  assert.deepEqual(await cost(), DEFAULTS);
  assert.equal(await audits().then((rows) => rows.length), 0);
  assert.equal(
    await ops.waitingCardCostsRequest(database.db),
    outcome.requestId,
  );
  // The asker can't approve their own change.
  await assert.rejects(approve(outcome.requestId, asker));
  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  assert.deepEqual(await cost(), {
    rateBps: 250n,
    fixedMinor: 5000n,
    marginMinor: 2000n,
  });
  const [history] = await ops.cardCostHistory(database.db, 1);
  assert.equal(history.setBy, asker);
  assert.equal(history.approvedBy, approver);
  const [audit] = await audits();
  assert.match(audit.reason, new RegExp(`"approvedBy":"${approver}"`));
  assert.equal(await ops.waitingCardCostsRequest(database.db), null);
});

test('a request goes stale when the card cost changed while it waited', async () => {
  const asker = await person();
  const approver = await person();
  const { requestId } = await ask(asker);
  await q(
    `INSERT INTO card_cost_settings (id, rate_bps, fixed_minor, margin_minor, effective_from, reason)
     VALUES (gen_random_uuid(), 300, 4500, 1500, now(), 'Changed meanwhile for the test')`,
  );
  const outcome = await approve(requestId, approver);
  assert.equal(outcome.status, 'stale');
  assert.equal((await cost()).rateBps, 300n);
});

test('an unchanged or malformed cost is refused INVALID_INPUT before anything is asked', async () => {
  const lone = await person();
  for (const payload of [
    { rateBps: 200, fixedMinor: '4500', marginMinor: '1500' },
    { rateBps: 10001, fixedMinor: '4500', marginMinor: '1500' },
    { rateBps: '200', fixedMinor: '4500', marginMinor: '1500' },
    { rateBps: 200, fixedMinor: '-1', marginMinor: '1500' },
    { rateBps: 200, fixedMinor: '45.00', marginMinor: '1500' },
  ])
    await assert.rejects(
      ask(lone, payload),
      (error) => error.code === 'INVALID_INPUT',
      JSON.stringify(payload),
    );
  assert.deepEqual(await cost(), DEFAULTS);
  assert.equal(await ops.waitingCardCostsRequest(database.db), null);
});
