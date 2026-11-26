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

// The owner, 18 Nov 2026: TipMe's fee per plan is an admin setting, Free 5% and Pro 3% to start. It is
// a money change: staff with fees.manage change it with a second approver (or alone, with the alert,
// when nobody else can, as every money switch), audited, for new quotes only.
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'The owner’s new rates, agreed today';
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
  // An empty rates table (the reset truncates it): the coded defaults, Free 500 and Pro 300.
  await database.reset();
  await ops.ensureOwnerRole(database.db);
  // Ada's page, for the quotes.
  await ops.seedDemoProfiles(database.db);
});

const people = new Map();
async function person({ roleId = 'owner' } = {}) {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`pf.${randomUUID().slice(0, 8)}@example.com`],
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

const ask = (actorId, freeBps, proBps) =>
  ops.requestSeriousAction(database.db, {
    name: 'plan_fees.change',
    payload: { freeBps, proBps },
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
  });
const askConfirmed = (actorId, freeBps, proBps) =>
  ops.requestSeriousAction(database.db, {
    name: 'plan_fees.change',
    payload: { freeBps, proBps, confirmLargeChange: true },
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
const rates = async () => {
  const r = await ops.planFeeRatesInForce(database.db);
  return [r.freeBps, r.proBps];
};
const quoteShare = async () => {
  const quote = await ops.createQuote(database.db, {
    handle: 'ada',
    tipMinor: 1_000_000n,
    currency: 'NGN',
  });
  return quote.breakdown.platformFeeMinor + quote.breakdown.providerFeeMinor;
};

test('GET /v1/plan-fees returns the rates in force, cached publicly for 60 seconds', async () => {
  const response = await fetch(`${stack.api}/v1/plan-fees`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual((await response.json()).data, { freeBps: 500, proBps: 300 });
});

test('staff without fees.manage get 403 from the fee screen’s routes', async () => {
  const phone = `+23484${String(Date.now()).slice(-8)}`;
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
  const read = await fetch(`${stack.api}/v1/ops/plan-fees`, {
    headers: browserHeaders(session.cookie),
  });
  assert.equal(read.status, 403);
  const change = await fetch(`${stack.api}/v1/ops/plan-fees`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ freeBps: '450', proBps: '250', reason: REASON }),
  });
  assert.equal(change.status, 403);
});

test('an owner reads the rates, their source, the business payout rule and no waiting change', async () => {
  const session = await opsSignIn(
    stack.api,
    database.db,
    `+23485${String(Date.now()).slice(-8)}`,
  );
  const response = await fetch(`${stack.api}/v1/ops/plan-fees`, {
    headers: browserHeaders(session.cookie),
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  // The reset seeds the migration's row, so the rates come from the setting.
  assert.deepEqual(
    { ...data.current, effectiveFrom: typeof data.current.effectiveFrom },
    {
      freeBps: 500,
      proBps: 300,
      source: 'setting',
      effectiveFrom: 'string',
    },
  );
  assert.deepEqual(data.limits, { minBps: 150, maxBps: 1000 });
  assert.equal(data.waitingRequestId, null);
  // The business payout fee is a fee waiver rule now (spec 2026-11-23 §5), not a switch shown here.
  assert.equal('business' in data, false);
  // Pro above Free is refused before anything is asked.
  const bad = await fetch(`${stack.api}/v1/ops/plan-fees`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ freeBps: '300', proBps: '500', reason: REASON }),
  });
  assert.equal(bad.status, 400);
});

test('with a second staff member a change waits, and quotes keep 5% until it is approved', async () => {
  const asker = await person();
  await person();
  const outcome = await ask(asker, '450', '250');
  assert.equal(outcome.state, 'pending');
  const [row] = await q(`SELECT * FROM approval_requests WHERE id = $1`, [
    outcome.requestId,
  ]);
  assert.equal(row.permission, 'fees.manage');
  assert.equal(
    row.summary,
    'Change TipMe’s fee from Free 5% and Pro 3% to Free 4.5% and Pro 2.5%, for new tips only',
  );
  assert.deepEqual(await rates(), [500n, 300n]);
  assert.equal(await quoteShare(), 50_000n);
  assert.equal(
    await ops.waitingPlanFeesRequest(database.db),
    outcome.requestId,
  );
});

test('the asker can’t approve their own change', async () => {
  const asker = await person();
  await person();
  const { requestId } = await ask(asker, '450', '250');
  await assert.rejects(approve(requestId, asker));
  assert.deepEqual(await rates(), [500n, 300n]);
});

test('on approval new quotes use the new rate, a quote shown before keeps its fee, and the audit names from, to and approver', async () => {
  const asker = await person();
  const approver = await person();
  const before = await ops.createQuote(database.db, {
    handle: 'ada',
    tipMinor: 1_000_000n,
    currency: 'NGN',
  });
  const { requestId } = await ask(asker, '450', '250');
  const outcome = await approve(requestId, approver);
  assert.equal(outcome.status, 'approved', JSON.stringify(outcome));
  assert.deepEqual(await rates(), [450n, 250n]);
  assert.equal(await quoteShare(), 45_000n);
  const charge = await ops.findQuoteCharge(database.db, before.quoteId);
  assert.equal(charge.platformFeeMinor + charge.providerFeeMinor, 50_000n);
  const [history] = await ops.planFeeRateHistory(database.db);
  assert.equal(history.setBy, asker);
  assert.equal(history.approvedBy, approver);
  const [audit] = await q(
    `SELECT staff_user_id, permission, reason FROM audit_events WHERE action = 'plan_fees.changed' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(audit.staff_user_id, asker);
  assert.equal(audit.permission, 'fees.manage');
  assert.ok(audit.reason.startsWith(REASON));
  assert.match(audit.reason, /"from":\{"freeBps":"500","proBps":"300"\}/);
  assert.match(audit.reason, /"to":\{"freeBps":"450","proBps":"250"\}/);
  assert.match(audit.reason, new RegExp(`"approvedBy":"${approver}"`));
  // The public route follows (its own answer is not cached here).
  const response = await fetch(`${stack.api}/v1/plan-fees`);
  assert.deepEqual((await response.json()).data, { freeBps: 450, proBps: 250 });
});

test('a lone admin runs it alone, with the acted-alone alert, as every money switch', async () => {
  const lone = await person();
  const outcome = await ask(lone, '450', '250');
  assert.equal(outcome.state, 'ran');
  assert.equal(outcome.aloneReason, 'no_second_person');
  assert.deepEqual(await rates(), [450n, 250n]);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.acted_alone'`,
      )
    ).length,
    1,
  );
  const [audit] = await q(
    `SELECT reason FROM audit_events WHERE action = 'plan_fees.changed' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.match(audit.reason, /"approvedBy":null/);
});

test('a request goes stale when the rates changed while it waited', async () => {
  const asker = await person();
  const approver = await person();
  const { requestId } = await ask(asker, '450', '250');
  await q(
    `INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, reason)
     VALUES (gen_random_uuid(), 400, 200, now(), 'Changed meanwhile for the test')`,
  );
  const outcome = await approve(requestId, approver);
  assert.equal(outcome.status, 'stale');
  assert.deepEqual(await rates(), [400n, 200n]);
});

test('out-of-range rates, Pro above Free and unchanged rates are refused INVALID_INPUT', async () => {
  const lone = await person();
  for (const [free, pro] of [
    ['10001', '300'],
    ['1001', '300'],
    ['149', '149'],
    ['500', '149'],
    ['0', '0'],
    ['-1', '300'],
    ['300', '500'],
    ['5.5', '3'],
    ['500', '300'],
  ])
    await assert.rejects(
      ask(lone, free, pro),
      (error) => error.code === 'INVALID_INPUT',
      `${free}/${pro}`,
    );
  assert.deepEqual(await rates(), [500n, 300n]);
});

test('a move of more than 200 bps is refused without the explicit confirm, and runs with it', async () => {
  const lone = await person();
  // 500 to 701 on Free is 201 bps: refused, nothing stored, no request left waiting.
  await assert.rejects(
    ask(lone, '701', '300'),
    (error) => error.code === 'PLAN_FEES_CONFIRM_REQUIRED',
  );
  assert.deepEqual(await rates(), [500n, 300n]);
  assert.equal(await ops.waitingPlanFeesRequest(database.db), null);
  // Exactly 200 needs no confirm.
  assert.equal((await ask(lone, '700', '300')).state, 'ran');
  assert.deepEqual(await rates(), [700n, 300n]);
  // A big move with the flag goes through.
  assert.equal((await askConfirmed(lone, '1000', '300')).state, 'ran');
  assert.deepEqual(await rates(), [1000n, 300n]);
});

// Fee waivers (spec 2026-11-23 §5) replace the business payout fee switch: who pays a business's
// withdrawal fee is the business kind rule, set through `fee_waiver.set` with a second person.
test('the business payout fee is the business kind rule: a change waits for a second person', async () => {
  const asker = await person();
  const approver = await person();
  const business = { owner: { businessId: randomUUID() }, fee: 'withdrawal' };
  const payer = async () =>
    (await ops.feeWaiverFor(database.db, { ...business, now: new Date() }))
      .payer;
  // The reset's carried-over rule: the business pays (the switch was off).
  assert.equal(await payer(), 'default');
  const outcome = await ops.requestSeriousAction(database.db, {
    name: 'fee_waiver.set',
    payload: {
      scope: 'kind',
      kind: 'business',
      fee: 'withdrawal',
      payer: 'tipme',
      confirmCost: true,
      // The estimate the screen showed: no business withdrawals in the last 30 days.
      costEstimateMinor: '0',
    },
    actorId: asker,
    grantId: people.get(asker).grantId,
    reason: REASON,
    services: services(),
  });
  assert.equal(outcome.state, 'pending');
  assert.equal(await payer(), 'default');
  assert.equal((await approve(outcome.requestId, approver)).status, 'approved');
  assert.equal(await payer(), 'tipme');
});
