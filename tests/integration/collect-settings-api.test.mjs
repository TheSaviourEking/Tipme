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

/*
 * You collect's settings in admin (plan Task 12, spec §9), exactly like the plan fee rates: reading is
 * `fees.manage`; a change is the serious action `collect_settings.change` (a second person approves,
 * or a lone admin acts alone with the acted-alone alert), audited from, to and approver, in force at
 * once. Beyond the table's own bounds the setter refuses critical not below warning, a reminder on
 * or after the cap's last day, and a first-withdrawal cap below the minimum withdrawal, and keeps
 * reminder days de-duplicated and sorted. Staff pause and resume every collect transfer (R11) with
 * `collect_transfers.pause` and `collect_transfers.resume`, a new settings row each time.
 */

const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'The owner’s new limits, agreed today';
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});
const DEFAULTS = {
  capMinor: '5000000',
  capDays: 30,
  reminderDays: [7, 21, 28],
  delayHours: 24,
  delayForDays: 7,
  firstWithdrawalCapMinor: '5000000',
  newDailyLimitMinor: '20000000',
  newDailyLimitDays: 30,
  reserveWarningMinor: '50000000',
  reserveCriticalMinor: '25000000',
};

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
  await database.reset();
  await ops.ensureOwnerRole(database.db);
});

const people = new Map();
async function person({ roleId = 'owner' } = {}) {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`cs.${randomUUID().slice(0, 8)}@example.com`],
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

const ask = (actorId, name, payload) =>
  ops.requestSeriousAction(database.db, {
    name,
    payload,
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
  });
const change = (actorId, edits) =>
  ask(actorId, 'collect_settings.change', { ...DEFAULTS, ...edits });
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
const inForce = () => ops.collectSettingsInForce(database.db);
const outbox = (type) =>
  q(`SELECT payload FROM outbox_events WHERE event_type = $1`, [type]);

test('settings out of bounds, critical not below warning, or a reminder after the cap are refused; a change needs the serious action and alerts owners', async () => {
  const lone = await person();
  for (const [why, edits] of [
    ['cap below ₦10,000', { capMinor: '999999' }],
    ['cap above ₦500,000', { capMinor: '50000001' }],
    ['cap days below 7', { capDays: 6 }],
    ['cap days above 90', { capDays: 91 }],
    ['delay above 72 h', { delayHours: 73 }],
    ['delay for more than 30 days', { delayForDays: 31 }],
    ['critical equal to warning', { reserveCriticalMinor: '50000000' }],
    ['critical above warning', { reserveCriticalMinor: '60000000' }],
    ['a reminder on the cap day', { reminderDays: [7, 21, 30] }],
    ['a reminder after the cap', { capDays: 20, reminderDays: [7, 21] }],
    ['a reminder on day 0', { reminderDays: [0, 7] }],
    ['no reminders', { reminderDays: [] }],
    [
      'first cap below the minimum withdrawal',
      { firstWithdrawalCapMinor: '199999' },
    ],
    [
      'a daily limit below the minimum withdrawal',
      { newDailyLimitMinor: '199999' },
    ],
    ['a fractional amount', { capMinor: '5000000.5' }],
    ['a negative amount', { reserveCriticalMinor: '-1' }],
    ['the settings already in force', {}],
  ])
    await assert.rejects(
      change(lone, edits),
      (error) => error.code === 'INVALID_INPUT',
      why,
    );
  assert.equal((await inForce()).source, 'default');
  assert.equal((await q(`SELECT 1 FROM collect_settings`)).length, 0);
  // The minimum withdrawal itself is allowed (₦2,000, the smallest tip).
  assert.equal(
    (await change(lone, { firstWithdrawalCapMinor: '200000' })).state,
    'ran',
  );
  assert.equal((await inForce()).firstWithdrawalCapMinor, 200000n);

  // With a second person, a change waits; nothing moves until they approve.
  const asker = await person();
  const approver = await person();
  const pending = await change(asker, { capMinor: '10000000' });
  assert.equal(pending.state, 'pending');
  const [row] = await q(
    `SELECT permission, summary FROM approval_requests WHERE id = $1`,
    [pending.requestId],
  );
  assert.equal(row.permission, 'fees.manage');
  assert.match(row.summary, /holding cap from ₦50,000 to ₦100,000/);
  assert.equal((await inForce()).capMinor, 5_000_000n);
  assert.deepEqual(
    (await outbox('ops.approval_pending')).map((e) => e.payload.action),
    ['collect_settings.change'],
  );
  await assert.rejects(approve(pending.requestId, asker));
  const approved = await approve(pending.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  const now = await inForce();
  assert.equal(now.capMinor, 10_000_000n);
  // The whole set is the one asked for, the earlier lone change included only where asked.
  assert.equal(now.firstWithdrawalCapMinor, 5_000_000n);
  const [audit] = await q(
    `SELECT staff_user_id, permission, reason FROM audit_events
      WHERE action = 'collect_settings.changed' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(audit.staff_user_id, asker);
  assert.equal(audit.permission, 'fees.manage');
  assert.ok(audit.reason.startsWith(REASON));
  assert.match(audit.reason, /"from":\{[^}]*"capMinor":"5000000"/);
  assert.match(audit.reason, /"to":\{[^}]*"capMinor":"10000000"/);
  assert.match(audit.reason, new RegExp(`"approvedBy":"${approver}"`));
  const [stored] = await q(
    `SELECT set_by, approved_by FROM collect_settings ORDER BY created_at DESC LIMIT 1`,
  );
  assert.deepEqual(stored, { set_by: asker, approved_by: approver });

  // The lone admin's change ran alone, with the acted-alone alert to the owners.
  assert.deepEqual(
    (await outbox('ops.acted_alone')).map((e) => e.payload.action),
    ['collect_settings.change'],
  );
});

test('reminder days are de-duplicated and sorted, and a stale request does not apply', async () => {
  const lone = await person();
  assert.equal(
    (await change(lone, { reminderDays: [28, 7, 21, 7, 14] })).state,
    'ran',
  );
  assert.deepEqual((await inForce()).reminderDays, [7, 14, 21, 28]);
  const asker = await person();
  const approver = await person();
  const { requestId } = await change(asker, { capDays: 45 });
  // Changed meanwhile: the request was asked against other settings.
  await q(
    `INSERT INTO collect_settings (id, cap_minor, cap_days, reminder_days, delay_hours, delay_for_days,
       first_withdrawal_cap_minor, new_daily_limit_minor, new_daily_limit_days,
       reserve_warning_minor, reserve_critical_minor, effective_from, reason)
     VALUES (gen_random_uuid(), 5000000, 60, '{7,21,28}', 24, 7, 5000000, 20000000, 30,
       50000000, 25000000, now(), 'Changed meanwhile for the test')`,
  );
  assert.equal((await approve(requestId, approver)).status, 'stale');
  assert.equal((await inForce()).capDays, 60);
});

test('collect transfers pause and resume through serious actions, keeping the settings', async () => {
  const lone = await person();
  await change(lone, { capDays: 45 });
  await assert.rejects(
    ask(lone, 'collect_transfers.resume', {}),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.equal((await ask(lone, 'collect_transfers.pause', {})).state, 'ran');
  let settings = await inForce();
  assert.equal(settings.paused, true);
  assert.equal(settings.capDays, 45);
  // The transfer machine reads it before every row: nothing is asked of the partner.
  const run = await ops.runCollectTransfers(database.db, {
    provider: {
      name: 'bachs-sandbox',
      async sendCollectTransfer() {
        throw new Error('paused: never sent');
      },
      async listAccountTransfers() {
        throw new Error('paused: never listed');
      },
      async payoutCapability() {
        throw new Error('paused: never read');
      },
    },
    now: new Date(),
  });
  assert.equal(run.stopped, 'paused');
  await assert.rejects(
    ask(lone, 'collect_transfers.pause', {}),
    (error) => error.code === 'INVALID_INPUT',
  );
  // Settings changed while paused stay paused.
  await change(lone, { capDays: 50 });
  settings = await inForce();
  assert.deepEqual([settings.paused, settings.capDays], [true, 50]);
  // With a second person, resuming waits for them.
  const asker = await person();
  const approver = await person();
  const pending = await ask(asker, 'collect_transfers.resume', {});
  assert.equal(pending.state, 'pending');
  assert.equal((await inForce()).paused, true);
  assert.equal((await approve(pending.requestId, approver)).status, 'approved');
  settings = await inForce();
  assert.deepEqual([settings.paused, settings.capDays], [false, 50]);
  const audits = await q(
    `SELECT action, permission FROM audit_events
      WHERE action IN ('collect_transfers.paused', 'collect_transfers.resumed')
      ORDER BY created_at`,
  );
  assert.deepEqual(audits, [
    { action: 'collect_transfers.paused', permission: 'payments.repair' },
    { action: 'collect_transfers.resumed', permission: 'payments.repair' },
  ]);
});

test('staff read the settings in force; only fees.manage reads or changes them, with a fresh code', async () => {
  const session = await opsSignIn(
    stack.api,
    database.db,
    `+23486${String(Date.now()).slice(-8)}`,
  );
  const read = await fetch(`${stack.api}/v1/ops/collect-settings`, {
    headers: browserHeaders(session.cookie),
  });
  assert.equal(read.status, 200);
  const { data } = await read.json();
  assert.deepEqual(data.current, {
    ...DEFAULTS,
    paused: false,
    source: 'default',
    effectiveFrom: null,
  });
  assert.deepEqual(data.history, []);
  assert.equal(data.minWithdrawalMinor, '200000');
  assert.equal(data.waitingRequestId, null);
  // A change from the screen: the signed-in owner is the only staff, so it runs alone.
  const changed = await fetch(`${stack.api}/v1/ops/collect-settings`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ ...DEFAULTS, capDays: 40, reason: REASON }),
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  const after = (await changed.json()).data;
  assert.equal(after.current.capDays, 40);
  assert.equal(after.current.source, 'setting');
  assert.equal(after.actedAlone, true);
  assert.equal(after.history.length, 1);
  // Bad input never reaches the serious action.
  const bad = await fetch(`${stack.api}/v1/ops/collect-settings`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ ...DEFAULTS, capDays: 'thirty', reason: REASON }),
  });
  assert.equal(bad.status, 400);
  // Pause and resume from the screen.
  const pause = await fetch(`${stack.api}/v1/ops/collect-transfers/pause`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ reason: 'Checking an incident' }),
  });
  assert.equal(pause.status, 200, await pause.clone().text());
  assert.equal((await pause.json()).data.current.paused, true);
  const resume = await fetch(`${stack.api}/v1/ops/collect-transfers/resume`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ reason: 'Incident closed' }),
  });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).data.current.paused, false);

  // Without fees.manage: 403 on reading and changing; without payments.repair: 403 on pausing.
  const role = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [role]);
  await q(
    `INSERT INTO role_permissions (role_id, permission)
     SELECT $1, permission FROM role_permissions
      WHERE role_id = 'owner' AND permission NOT IN ('fees.manage', 'payments.repair')`,
    [role],
  );
  const phone = `+23487${String(Date.now()).slice(-8)}`;
  const limited = await opsSignIn(stack.api, database.db, phone);
  await q(
    `UPDATE staff SET role_id = $1 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $2)`,
    [role, phone],
  );
  for (const [method, path, body] of [
    ['GET', '/v1/ops/collect-settings'],
    ['POST', '/v1/ops/collect-settings', { ...DEFAULTS, reason: REASON }],
    ['POST', '/v1/ops/collect-transfers/pause', { reason: REASON }],
    ['POST', '/v1/ops/collect-transfers/resume', { reason: REASON }],
  ]) {
    const response = await fetch(`${stack.api}${path}`, {
      method,
      headers: browserHeaders(limited.cookie),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
});
