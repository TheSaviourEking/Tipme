import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import pg from '../../packages/database/node_modules/pg/lib/index.js';
import { sql } from '../../packages/database/node_modules/drizzle-orm/index.js';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import * as contracts from '../../packages/contracts/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import * as guardModule from '../../apps/api/dist/ops/ops.guard.js';
const routeAllows = (...args) => guardModule.routeAllows(...args);
import { handleDomainEvent } from '../../apps/worker/dist/handlers/domain-events.js';
import {
  MAIL_SEAL_KEY,
  OPS_TOTP_KEY,
  WEB,
  browserHeaders,
  opsSignIn,
  startStack,
} from './helpers.mjs';

const { OperationError, registerSeriousAction, requestSeriousAction } = ops;
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));

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
  await ops.ensureOwnerRole(database.db);
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

const runs = [];
const facts = { refuse: null };
const ACTION = 'test.approve_me';
const REASON = 'The provider confirmed the change by phone';
registerSeriousAction({
  name: ACTION,
  permission: 'fees.manage',
  validate: async () => {
    if (facts.refuse) throw new OperationError(facts.refuse);
  },
  describe: async (_tx, payload) =>
    `Set the test value to ${payload.value}${facts.describeSuffix ?? ''}`,
  run: async (tx, payload, ctx) => {
    await tx.execute(sql`SELECT 1`);
    // Long enough for anything racing it to arrive while it is mid-run: see `whileRunning`.
    if (facts.slowRun) await tx.execute(sql`SELECT pg_sleep(0.3)`);
    runs.push({ payload, ctx });
    return { applied: payload.value };
  },
});
// Writes, then fails: nothing it wrote may survive.
registerSeriousAction({
  name: 'test.fails_after_writing',
  permission: 'fees.manage',
  validate: async () => {},
  describe: async () => 'Fails after writing',
  run: async (tx, _payload, ctx) => {
    await ops.recordAudit(tx, {
      staffUserId: ctx.actorId,
      action: 'test.partial_write',
      now: ctx.now,
    });
    throw new OperationError('ROLE_NOT_FOUND');
  },
});
registerSeriousAction({
  name: 'test.breaks',
  permission: 'fees.manage',
  validate: async () => {},
  describe: async () => 'Breaks unexpectedly',
  run: async () => {
    throw new Error('a bug');
  },
});
// Only an owner may decide it, the person it's about may not, and it pins a current value.
const gated = { current: 'one' };
registerSeriousAction({
  name: 'test.gated',
  permission: 'fees.manage',
  validate: async () => {},
  describe: async (_tx, payload) => `Gated ${payload.target}`,
  mayDecide: async (_tx, _payload, approver) =>
    approver.access.roleId === 'owner',
  subjects: (payload) => (payload.subject ? [payload.subject] : []),
  target: (payload) => payload.target,
  current: async () => ({ value: gated.current }),
  run: async (_tx, payload, ctx) => {
    runs.push({ payload, ctx });
  },
});
const signal = {};
registerSeriousAction({
  name: 'test.waits_in_js',
  permission: 'fees.manage',
  validate: async () => {},
  describe: async () => 'Waits on something other than the database',
  run: async (tx, _payload, ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 16_500));
    try {
      await ops.recordAudit(tx, {
        staffUserId: ctx.actorId,
        action: 'test.stray_write',
        now: ctx.now,
      });
    } catch (error) {
      signal.strayRefused = true;
      throw error;
    }
  },
});
registerSeriousAction({
  name: 'test.reenters_lock',
  permission: 'fees.manage',
  validate: async () => {},
  describe: async () => 'Re-enters the staff-admin lock',
  run: async (tx) => {
    signal.inRun?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ops.lockStaffAdmin(tx);
    return { reentered: true };
  },
});
registerSeriousAction({
  name: 'test.slow',
  permission: 'fees.manage',
  validate: async () => {},
  describe: async () => 'Runs too long',
  run: async (tx) => {
    await tx.execute(sql`SELECT pg_sleep(30)`);
  },
});

const people = new Map();
let phoneSeq = 0;

beforeEach(async () => {
  runs.length = 0;
  facts.refuse = null;
  facts.describeSuffix = undefined;
  facts.slowRun = false;
  gated.current = 'one';
  await q('DELETE FROM ops_sessions');
  await q('DELETE FROM ops_lockouts');
  await q('DELETE FROM staff_totp');
  await q('DELETE FROM staff_enrolments');
  await q('DELETE FROM staff_permission_overrides');
  await q('DELETE FROM staff');
  await q('DELETE FROM approval_requests');
  await q('DELETE FROM outbox_events');
  await q(`DELETE FROM issues WHERE kind LIKE 'staff_%'`);
});

async function person({
  roleId = 'owner',
  email = null,
  verified = false,
  enrolled = true,
} = {}) {
  const phone = email
    ? null
    : `+23480777${String(++phoneSeq).padStart(5, '0')}`;
  const [{ id }] = await q(
    `INSERT INTO users (id, email, phone_e164, email_verified_at)
     VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
    [email, phone, verified ? new Date() : null],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [id, roleId],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, $3)`,
    [id, ops.sealSecret(key, secret), enrolled ? new Date() : null],
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

async function roleWith(permissions) {
  const id = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [id]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
  return id;
}

const codeOf = (id) =>
  totpAt(people.get(id).secret, BigInt(Math.floor(Date.now() / 30_000)));

const ask = async (actorId, overrides = {}) => {
  const outcome = await requestSeriousAction(database.db, {
    name: ACTION,
    payload: { value: 'x' },
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    ...overrides,
  });
  assert.equal(outcome.state, 'pending');
  return outcome.requestId;
};
const approve = (requestId, actorId, overrides = {}) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: codeOf(actorId),
    key,
    ...overrides,
  });
const rowOf = async (id) =>
  (await q(`SELECT * FROM approval_requests WHERE id = $1`, [id]))[0];
const auditOf = (id, action) =>
  q(
    `SELECT * FROM audit_events WHERE subject_id = $1 AND action = $2 ORDER BY seq`,
    [id, action],
  );
const lastStep = async (id) =>
  (await q(`SELECT last_step FROM staff_totp WHERE user_id = $1`, [id]))[0]
    .last_step;
const refusedWith = (code) => (error) => {
  assert.ok(error instanceof OperationError, String(error));
  assert.equal(error.code, code);
  return true;
};
const waitFor = async (check, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out');
};
const twoPeople = async () => [await person(), await person()];

// ---- Who may approve ----

test('you cannot approve your own request', async () => {
  const [asker] = await twoPeople();
  const id = await ask(asker);
  await assert.rejects(approve(id, asker), refusedWith('APPROVAL_OWN_REQUEST'));
  assert.equal(runs.length, 0);
  assert.equal((await rowOf(id)).status, 'pending');
  assert.equal(await lastStep(asker), null, 'the code was not used up');
});

test('your second account on the same mailbox cannot approve either', async () => {
  const asker = await person({ email: 'Jane.Doe+admin@gmail.com' });
  const twin = await person({ email: 'janedoe@googlemail.com' });
  await person();
  const id = await ask(asker);
  await assert.rejects(approve(id, twin), refusedWith('APPROVAL_OWN_REQUEST'));
  assert.equal(runs.length, 0);
});

test('someone without the permission cannot approve', async () => {
  const [asker] = await twoPeople();
  const outsider = await person({ roleId: await roleWith(['issues.view']) });
  const id = await ask(asker);
  await assert.rejects(
    approve(id, outsider),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  assert.equal(await lastStep(outsider), null);
  assert.equal((await rowOf(id)).status, 'pending');
});

test('an approver who is removed or mid-reset cannot approve', async () => {
  const asker = await person();
  const removed = await person();
  const midReset = await person();
  await person();
  const id = await ask(asker);
  await q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [removed]);
  await assert.rejects(
    approve(id, removed),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  const code = codeOf(midReset);
  await q(`UPDATE staff_totp SET confirmed_at = NULL WHERE user_id = $1`, [
    midReset,
  ]);
  await assert.rejects(
    approve(id, midReset, { code }),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  assert.equal(runs.length, 0);
});

// ---- Running it ----

/**
 * Starts an approval and lets the other thing arrive while it is mid-run. Starting both together
 * was too gentle: with every lock removed the first was often done before the second read the row.
 */
const whileRunning = async (approval, other) => {
  facts.slowRun = true;
  const running = approval();
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Promise.allSettled([running, other()]);
};

test('a second approver arriving mid-run is refused, and the action runs once', async () => {
  const asker = await person();
  const first = await person();
  const second = await person();
  const id = await ask(asker);
  const [won, lost] = await whileRunning(
    () => approve(id, first),
    () => approve(id, second),
  );
  assert.equal(won.value.status, 'approved');
  assert.equal(lost.reason?.code, 'APPROVAL_CLOSED');
  assert.equal(runs.length, 1);
  assert.equal((await rowOf(id)).decided_by, first);
  assert.equal((await auditOf(id, 'serious_action.ran')).length, 1);
});

test('approval runs the action once, even with two approvers at once', async () => {
  const asker = await person();
  const first = await person();
  const second = await person();
  const id = await ask(asker);
  const outcomes = await Promise.allSettled([
    approve(id, first),
    approve(id, second),
  ]);
  assert.equal(runs.length, 1);
  const won = outcomes.filter((o) => o.status === 'fulfilled');
  assert.equal(won.length, 1);
  assert.equal(won[0].value.status, 'approved');
  assert.deepEqual(won[0].value.result, { applied: 'x' });
  const lost = outcomes.find((o) => o.status === 'rejected');
  assert.equal(lost.reason.code, 'APPROVAL_CLOSED');
  // The loser's code was never consumed.
  const row = await rowOf(id);
  assert.equal(row.status, 'approved');
  const loser = row.decided_by === first ? second : first;
  assert.equal(await lastStep(loser), null);
});

test('a double click from one approver runs once and says it is closed', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  const code = codeOf(approver);
  await approve(id, approver, { code });
  await assert.rejects(
    approve(id, approver, { code }),
    refusedWith('APPROVAL_CLOSED'),
  );
  assert.equal(runs.length, 1);
});

test('the audit event names both people, and the run knows who approved', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  await approve(id, approver, { reason: 'Checked it against the ticket' });
  const row = await rowOf(id);
  assert.equal(row.decided_by, approver);
  assert.ok(row.decided_at);
  assert.equal(runs[0].ctx.actorId, asker);
  assert.equal(runs[0].ctx.approverId, approver);
  assert.equal(runs[0].ctx.reason, REASON);

  const [approved] = await auditOf(id, 'serious_action.approved');
  assert.equal(approved.staff_user_id, approver);
  assert.equal(approved.permission, 'fees.manage');
  assert.match(approved.reason, /^Checked it against the ticket \[change: /);
  const [ran] = await auditOf(id, 'serious_action.ran');
  assert.ok(ran.reason.startsWith(REASON));
  for (const entry of [approved, ran]) {
    assert.ok(entry.reason.includes(`"requestedBy":"${asker}"`));
    assert.ok(entry.reason.includes(`"approvedBy":"${approver}"`));
    assert.ok(entry.reason.includes('Set the test value to x'));
  }
});

test('a reason on approval may not forge the server record', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  await assert.rejects(
    approve(id, approver, { reason: 'Looks fine [change: {"approvedBy":1}]' }),
    refusedWith('INVALID_INPUT'),
  );
  assert.equal((await rowOf(id)).status, 'pending');
  assert.equal(await lastStep(approver), null);
});

// ---- Stale people and facts ----

test('a requester who was removed or lost the permission closes the request without running', async () => {
  for (const change of [
    (id) => q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [id]),
    (id) =>
      q(
        `UPDATE users SET deleted_at = now(), phone_e164 = NULL WHERE id = $1`,
        [id],
      ),
    async (id) =>
      q(`UPDATE staff SET role_id = $1 WHERE user_id = $2`, [
        await roleWith(['issues.view']),
        id,
      ]),
  ]) {
    const [asker, approver] = await twoPeople();
    const id = await ask(asker);
    await change(asker);
    const outcome = await approve(id, approver);
    assert.equal(outcome.status, 'stale');
    assert.equal(outcome.why, 'requester_lost_access');
    assert.equal(runs.length, 0);
    const row = await rowOf(id);
    assert.equal(row.status, 'stale');
    assert.equal(row.decided_by, approver);
    const [entry] = await auditOf(id, 'serious_action.stale');
    assert.equal(entry.staff_user_id, approver);
    assert.ok(entry.reason.includes(`"requestedBy":"${asker}"`));
    assert.ok(entry.reason.includes(`"approvedBy":"${approver}"`));
  }
});

test('facts that changed stop the action and mark it stale', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  facts.refuse = 'ROLE_NOT_FOUND';
  const outcome = await approve(id, approver);
  assert.equal(outcome.status, 'stale');
  assert.equal(outcome.why, 'facts_changed');
  assert.equal(runs.length, 0);
  assert.equal((await rowOf(id)).status, 'stale');
  // The screen gets a safe reason; the raw code stays in the log.
  assert.equal((await rowOf(id)).decided_reason, 'facts_changed');
  const [stale] = await auditOf(id, 'serious_action.stale');
  assert.ok(stale.reason.includes('ROLE_NOT_FOUND'));
  assert.equal((await auditOf(id, 'serious_action.ran')).length, 0);
});

test('what would change no longer matching what the approver read stops the action', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  facts.describeSuffix = ' and something else';
  const outcome = await approve(id, approver);
  assert.equal(outcome.status, 'stale');
  assert.equal(outcome.why, 'description_changed');
  assert.equal(runs.length, 0);
});

test('a refusal partway through a run keeps nothing it wrote, and closes the request', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker, {
    name: 'test.fails_after_writing',
    payload: { value: 'y' },
  });
  const outcome = await approve(id, approver);
  assert.equal(outcome.status, 'stale');
  assert.equal((await rowOf(id)).status, 'stale');
  assert.equal(
    (await q(`SELECT 1 FROM audit_events WHERE action = 'test.partial_write'`))
      .length,
    0,
  );
});

test('an action no process recognises closes rather than sitting there', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  await q(`UPDATE approval_requests SET action = 'test.gone' WHERE id = $1`, [
    id,
  ]);
  const outcome = await approve(id, approver);
  assert.equal(outcome.status, 'stale');
  assert.equal(outcome.why, 'action_unknown');
});

test('an unexpected failure in a run leaves the request pending and the code unused', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker, { name: 'test.breaks', payload: {} });
  await assert.rejects(approve(id, approver));
  assert.equal((await rowOf(id)).status, 'pending');
  assert.equal(await lastStep(approver), null);
});

// ---- Codes ----

test('approve needs a code entered for that approval, not the 5-minute window', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  // The approver's grant had a code seconds ago. That doesn't count.
  const missing = await approve(id, approver, { code: '' });
  assert.equal(missing.status, 'invalid');
  const wrong = await approve(id, approver, { code: '000000' });
  assert.equal(wrong.status, 'invalid');
  assert.equal(runs.length, 0);
  assert.equal((await rowOf(id)).status, 'pending');
  // A wrong code counts towards the lockout, and that sticks.
  const [{ failures }] = await q(
    `SELECT failures FROM ops_lockouts WHERE user_id = $1`,
    [approver],
  );
  assert.equal(failures, 2);
  assert.equal((await approve(id, approver)).status, 'approved');
  assert.equal(runs.length, 1);
});

test('a code already used elsewhere is refused, without closing anything or counting as a guess', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  const code = codeOf(approver);
  const step = BigInt(Math.floor(Date.now() / 30_000));
  await q(`UPDATE staff_totp SET last_step = $1 WHERE user_id = $2`, [
    (step + 1n).toString(),
    approver,
  ]);
  const outcome = await approve(id, approver, { code });
  assert.equal(outcome.status, 'reused');
  assert.equal((await rowOf(id)).status, 'pending');
  assert.equal(
    (await q(`SELECT 1 FROM ops_lockouts WHERE user_id = $1`, [approver]))
      .length,
    0,
  );
});

test('a locked approver is refused, and nothing closes', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  await q(
    `INSERT INTO ops_lockouts (user_id, failures, locked_until) VALUES ($1, 0, now() + interval '10 minutes')`,
    [approver],
  );
  assert.equal((await approve(id, approver)).status, 'locked');
  assert.equal((await rowOf(id)).status, 'pending');
});

test('STAFF_ADMIN_BUSY on the lock uses up nothing, and the same code then works', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  const code = codeOf(approver);
  const holder = new pg.Client({ connectionString: database.url });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
    );
    await assert.rejects(
      approve(id, approver, { code }),
      refusedWith('STAFF_ADMIN_BUSY'),
    );
    await holder.query('ROLLBACK');
  } finally {
    await holder.end();
  }
  assert.equal((await rowOf(id)).status, 'pending');
  assert.equal(await lastStep(approver), null);
  assert.equal((await approve(id, approver, { code })).status, 'approved');
});

test('a run that overruns is STAFF_ADMIN_BUSY: request pending, code unused, nothing logged', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker, { name: 'test.slow', payload: {} });
  await assert.rejects(approve(id, approver), refusedWith('STAFF_ADMIN_BUSY'));
  assert.equal((await rowOf(id)).status, 'pending');
  assert.equal(await lastStep(approver), null);
  assert.equal((await auditOf(id, 'serious_action.approved')).length, 0);
  assert.equal((await auditOf(id, 'serious_action.stale')).length, 0);
});

// ---- Rejecting and cancelling ----

test('a second person rejects with a reason; nothing runs and it is logged', async () => {
  const [asker, other] = await twoPeople();
  const id = await ask(asker);
  const reject = (actorId, reason = 'That is not what the ticket asked for') =>
    ops.rejectRequest(database.db, {
      requestId: id,
      actorId,
      grantId: people.get(actorId).grantId,
      reason,
    });
  await assert.rejects(reject(asker), refusedWith('APPROVAL_OWN_REQUEST'));
  await assert.rejects(reject(other, 'short'), refusedWith('INVALID_INPUT'));
  await q(
    `UPDATE ops_sessions SET last_totp_at = now() - interval '6 minutes' WHERE user_id = $1`,
    [other],
  );
  await assert.rejects(reject(other), refusedWith('FRESH_CODE_REQUIRED'));
  await q(`UPDATE ops_sessions SET last_totp_at = now() WHERE user_id = $1`, [
    other,
  ]);
  await reject(other);
  assert.equal(runs.length, 0);
  const row = await rowOf(id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.decided_by, other);
  assert.equal(row.decided_reason, 'That is not what the ticket asked for');
  const [entry] = await auditOf(id, 'serious_action.rejected');
  assert.equal(entry.staff_user_id, other);
  assert.ok(entry.reason.includes(`"requestedBy":"${asker}"`));
  assert.ok(entry.reason.includes(`"rejectedBy":"${other}"`));
  await assert.rejects(reject(other), refusedWith('APPROVAL_CLOSED'));
});

test('only the requester can cancel', async () => {
  const [asker, other] = await twoPeople();
  const id = await ask(asker);
  await assert.rejects(
    ops.cancelRequest(database.db, { requestId: id, actorId: other }),
    refusedWith('APPROVAL_NOT_YOURS'),
  );
  await ops.cancelRequest(database.db, { requestId: id, actorId: asker });
  assert.equal((await rowOf(id)).status, 'cancelled');
  assert.equal((await auditOf(id, 'serious_action.cancelled')).length, 1);
  await assert.rejects(
    ops.cancelRequest(database.db, { requestId: id, actorId: asker }),
    refusedWith('APPROVAL_CLOSED'),
  );
  await assert.rejects(approve(id, other), refusedWith('APPROVAL_CLOSED'));
  assert.equal(runs.length, 0);
});

test('with the other qualified people gone, the requester cancels and acts alone', async () => {
  const [asker, other] = await twoPeople();
  const id = await ask(asker);
  await ops.removeStaff(database.db, {
    actorId: asker,
    userId: other,
    reason: 'They have left the company',
  });
  // It stays open until they say so, and the screen says why it's stuck.
  const [listed] = await ops.listApprovals(database.db, { actorId: asker });
  assert.equal(listed.id, id);
  assert.equal(listed.nobodyElseQualified, true);
  // Acting alone with the old request still open is refused: it could run a second time later.
  await assert.rejects(
    requestSeriousAction(database.db, {
      name: ACTION,
      payload: { value: 'x' },
      actorId: asker,
      grantId: people.get(asker).grantId,
      reason: REASON,
    }),
    refusedWith('APPROVAL_ALREADY_PENDING'),
  );
  assert.equal(runs.length, 0);
  await ops.cancelRequest(database.db, { requestId: id, actorId: asker });
  const outcome = await requestSeriousAction(database.db, {
    name: ACTION,
    payload: { value: 'x' },
    actorId: asker,
    grantId: people.get(asker).grantId,
    reason: REASON,
  });
  assert.equal(outcome.state, 'ran');
  assert.equal(runs.length, 1);
});

test('asking for the same thing twice gives the same request, and alerts once', async () => {
  const [asker] = await twoPeople();
  const first = await ask(asker);
  const second = await ask(asker);
  assert.equal(first, second);
  assert.notEqual(
    await ask(asker, { payload: { value: 'something else' } }),
    first,
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'ops.approval_pending'`,
      )
    ).length,
    2,
  );
});

// ---- Expiry ----

test('cancelling while it runs is refused: it ran, and the record says only that', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  const [approval, cancel] = await whileRunning(
    () => approve(id, approver),
    () => ops.cancelRequest(database.db, { requestId: id, actorId: asker }),
  );
  assert.equal(approval.value.status, 'approved');
  assert.equal(cancel.reason?.code, 'APPROVAL_CLOSED');
  assert.equal(runs.length, 1);
  assert.equal((await rowOf(id)).status, 'approved');
  assert.equal((await auditOf(id, 'serious_action.cancelled')).length, 0);
});

test('the sweep passes over a request being approved, even if its time is up', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  const [approval] = await whileRunning(
    () => approve(id, approver),
    () =>
      ops.expireRequests(database.db, {
        now: new Date(Date.now() + 25 * 60 * 60 * 1000),
      }),
  );
  assert.equal(approval.value.status, 'approved');
  assert.equal(runs.length, 1);
  assert.equal((await rowOf(id)).status, 'approved');
  assert.equal((await auditOf(id, 'serious_action.expired')).length, 0);
});

test('requests expire after 24 hours, and approve racing expiry runs at most once', async () => {
  const [asker, approver] = await twoPeople();
  const id = await ask(asker);
  const row = await rowOf(id);
  assert.equal(
    row.expires_at.getTime() - row.created_at.getTime(),
    24 * 60 * 60 * 1000,
  );

  // The sweep leaves it alone until then.
  assert.deepEqual(
    await ops.expireRequests(database.db, {
      now: new Date(row.expires_at.getTime() - 1000),
    }),
    { expired: 0 },
  );
  assert.equal((await rowOf(id)).status, 'pending');
  assert.deepEqual(
    await ops.expireRequests(database.db, { now: row.expires_at }),
    { expired: 1 },
  );
  assert.equal((await rowOf(id)).status, 'expired');
  const [entry] = await auditOf(id, 'serious_action.expired');
  assert.equal(entry.staff_user_id, null);
  assert.ok(entry.reason.includes(`"requestedBy":"${asker}"`));
  await assert.rejects(approve(id, approver), refusedWith('APPROVAL_CLOSED'));

  // Past its time but not yet swept: approving closes it, and uses no code.
  const late = await ask(asker, { payload: { value: 'late' } });
  await q(
    `UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [late],
  );
  assert.equal((await approve(late, approver)).status, 'expired');
  assert.equal((await rowOf(late)).status, 'expired');
  assert.equal(await lastStep(approver), null);
  assert.equal((await auditOf(late, 'serious_action.expired')).length, 1);

  // A race: whichever gets the row first, the action runs at most once and the record agrees.
  for (let i = 0; i < 5; i += 1) {
    runs.length = 0;
    await q(`UPDATE staff_totp SET last_step = NULL WHERE user_id = $1`, [
      approver,
    ]);
    const raced = await ask(asker, { payload: { value: `race${i}` } });
    const [approval, sweep] = await Promise.allSettled([
      approve(raced, approver),
      ops.expireRequests(database.db, {
        now: new Date(Date.now() + 25 * 60 * 60 * 1000),
      }),
    ]);
    assert.ok(runs.length <= 1);
    const final = await rowOf(raced);
    if (runs.length === 1) {
      assert.equal(final.status, 'approved');
      assert.equal(approval.value.status, 'approved');
    } else {
      assert.equal(final.status, 'expired');
      assert.equal(approval.status, 'rejected');
      assert.equal(approval.reason.code, 'APPROVAL_CLOSED');
    }
    assert.equal(sweep.status, 'fulfilled');
  }
});

test(
  'the worker sweeps lapsed requests on its own schedule',
  { timeout: 90_000 },
  async () => {
    const [asker] = await twoPeople();
    const id = await ask(asker);
    await q(
      `UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    await waitFor(async () => (await rowOf(id)).status === 'expired', 80_000);
    assert.equal((await auditOf(id, 'serious_action.expired')).length, 1);
  },
);

// ---- The list ----

test('the list shows the description, never the payload, and only what you may see', async () => {
  const asker = await person();
  const approver = await person();
  const outsider = await person({ roleId: await roleWith(['issues.view']) });
  const id = await ask(asker, {
    payload: { value: 'x', hidden: 'PAYLOADONLY' },
  });

  const mine = await ops.listApprovals(database.db, { actorId: asker });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].canDecide, false);
  assert.equal(mine[0].mine, true);
  assert.equal(mine[0].nobodyElseQualified, false);

  const [theirs] = await ops.listApprovals(database.db, { actorId: approver });
  assert.equal(theirs.id, id);
  assert.equal(theirs.summary, 'Set the test value to x');
  assert.equal(theirs.reason, REASON);
  assert.equal(theirs.canDecide, true);
  assert.equal(theirs.mine, false);
  assert.equal('payload' in theirs, false);
  assert.ok(!JSON.stringify(theirs).includes('PAYLOADONLY'));

  assert.deepEqual(
    await ops.listApprovals(database.db, { actorId: outsider }),
    [],
  );
  assert.deepEqual(
    await ops.listApprovals(database.db, {
      actorId: approver,
      status: 'approved',
    }),
    [],
  );
  // Past its time but not yet swept, it reads as what it is.
  await q(
    `UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [id],
  );
  const [lapsed] = await ops.listApprovals(database.db, {
    actorId: approver,
    status: 'expired',
  });
  assert.equal(lapsed.status, 'expired');
  assert.equal(lapsed.canDecide, false);
  assert.deepEqual(
    await ops.listApprovals(database.db, {
      actorId: approver,
      status: 'pending',
    }),
    [],
  );
});

// ---- Alerts ----

const mailTo = (type, userId) =>
  q(`SELECT * FROM mail_messages WHERE type = $1 AND user_id = $2`, [
    type,
    userId,
  ]);

test('a pending request alerts everyone qualified by mail and in the inbox, through the worker', async () => {
  const asker = await person({
    email: `asker-${randomUUID()}@example.com`,
    verified: true,
  });
  const approver = await person({
    email: `appr-${randomUUID()}@example.com`,
    verified: true,
  });
  const unverified = await person({
    email: `unver-${randomUUID()}@example.com`,
  });
  const outsider = await person({
    email: `out-${randomUUID()}@example.com`,
    verified: true,
    roleId: await roleWith(['issues.view']),
  });
  const id = await ask(asker, { payload: { value: 'SECRETWORD' } });
  await waitFor(
    async () => (await mailTo('staff_approval_pending', approver)).length === 1,
  );
  const issue = await waitFor(
    async () =>
      (
        await q(
          `SELECT * FROM issues WHERE kind = 'staff_approval_pending' AND subject->>'requestId' = $1`,
          [id],
        )
      )[0],
  );
  assert.ok(issue.summary.includes(ACTION));
  assert.ok(!issue.summary.includes('SECRETWORD'));
  for (const nobody of [asker, unverified, outsider])
    assert.equal((await mailTo('staff_approval_pending', nobody)).length, 0);

  // Once decided, the inbox stops asking.
  await approve(id, approver);
  await ops.autoResolveIssues(database.db, new Date());
  const [closed] = await q(`SELECT status FROM issues WHERE id = $1`, [
    issue.id,
  ]);
  assert.equal(closed.status, 'resolved');
});

test('a request already closed by the time the alert arrives mails nobody', async () => {
  const [asker] = await twoPeople();
  const approver = await person({
    email: `late-${randomUUID()}@example.com`,
    verified: true,
  });
  const id = await ask(asker);
  await ops.cancelRequest(database.db, { requestId: id, actorId: asker });
  await handleDomainEvent(
    'ops.approval_pending',
    {
      action: ACTION,
      requestedBy: asker,
      requestId: id,
      permission: 'fees.manage',
    },
    {
      db: database.db,
      logger: { info() {}, warn() {}, error() {} },
      dedupeKey: `ops.approval_pending.${randomUUID()}`,
      sealing,
      pretendPayment: true,
    },
  );
  assert.equal((await mailTo('staff_approval_pending', approver)).length, 0);
});

const lastAlerts = () =>
  q(
    `SELECT * FROM outbox_events WHERE event_type = 'ops.last_approver_removed' ORDER BY created_at`,
  );

test('removing the last other qualified person is alerted; removing one of several is not', async () => {
  const owner = await person();
  const first = await person();
  const second = await person();
  await ops.removeStaff(database.db, {
    actorId: owner,
    userId: first,
    reason: 'They have left the company',
  });
  assert.equal((await lastAlerts()).length, 0);
  await ops.removeStaff(database.db, {
    actorId: owner,
    userId: second,
    reason: 'They have left the company',
  });
  const [alert] = await lastAlerts();
  assert.equal(alert.payload.requestedBy, owner);
  // Every serious permission the owner role carried.
  const permissions = alert.payload.permissions.split(',');
  assert.ok(permissions.includes('fees.manage'));
  assert.ok(permissions.includes('staff.manage'));
  // Not a permission with no serious action behind it.
  assert.ok(!permissions.includes('audit.view'));
});

test('every kind of staff change that takes away the last other qualified person is alerted', async () => {
  const fees = () => roleWith(['fees.manage', 'issues.view']);
  const cases = {
    'changing their role': async (owner) => {
      const other = await person();
      const role = await roleWith(['issues.view']);
      await q(`UPDATE staff SET role_id = 'owner' WHERE user_id = $1`, [other]);
      return () =>
        ops.changeRole(database.db, {
          actorId: owner,
          userId: other,
          roleId: role,
          reason: 'Moving them to support duties',
        });
    },
    'a personal removal': async (owner) => {
      const other = await person({ roleId: await fees() });
      return () =>
        ops.setPersonalAccess(database.db, {
          actorId: owner,
          userId: other,
          additions: [],
          removals: ['fees.manage'],
          reason: 'They no longer handle fees',
        });
    },
    'editing their role': async (owner) => {
      const role = await fees();
      await person({ roleId: role });
      return () =>
        ops.updateRole(database.db, {
          actorId: owner,
          roleId: role,
          permissions: ['issues.view'],
          reason: 'This role no longer handles fees',
        });
    },
    'resetting their authenticator': async (owner) => {
      const other = await person({
        email: `reset-${randomUUID()}@example.com`,
        verified: true,
        roleId: await fees(),
      });
      return () =>
        ops.resetAuthenticator(database.db, {
          actorId: owner,
          userId: other,
          reason: 'They lost their phone today',
          sealing,
        });
    },
  };
  for (const [name, setUp] of Object.entries(cases)) {
    await q('DELETE FROM outbox_events');
    await q('DELETE FROM staff_permission_overrides');
    await q('UPDATE staff SET revoked_at = now()');
    const owner = await person();
    const change = await setUp(owner);
    await change();
    const alerts = await lastAlerts();
    assert.equal(alerts.length, 1, name);
    assert.ok(
      alerts[0].payload.permissions.split(',').includes('fees.manage'),
      name,
    );
  }
});

test('a second account on one mailbox was never a second person, so losing it is not alerted', async () => {
  const owner = await person({ email: 'sam.jones@gmail.com' });
  const twin = await person({ email: 'samjones+2@gmail.com' });
  await ops.removeStaff(database.db, {
    actorId: owner,
    userId: twin,
    reason: 'That was a duplicate account',
  });
  assert.equal((await lastAlerts()).length, 0);
});

test('the server command resetting the other owner is alerted too', async () => {
  await person();
  const other = await person({
    email: `grant-${randomUUID()}@example.com`,
    verified: true,
  });
  const [{ email }] = await q(`SELECT email FROM users WHERE id = $1`, [other]);
  await ops.grantOwner(database.db, { email });
  const [alert] = await lastAlerts();
  assert.equal(alert.payload.requestedBy, null);
});

test('the last-person alert reaches the inbox, every owner by mail, and the webhook point', async () => {
  const owner = await person({
    email: `own-${randomUUID()}@example.com`,
    verified: true,
  });
  const told = [];
  await handleDomainEvent(
    'ops.last_approver_removed',
    { permissions: 'fees.manage,staff.manage', requestedBy: owner },
    {
      db: database.db,
      logger: { info() {}, warn() {}, error() {} },
      dedupeKey: `ops.last_approver_removed.${randomUUID()}`,
      sealing,
      pretendPayment: true,
      postStaffAlert: async (alert) => told.push(alert),
    },
  );
  assert.deepEqual(told, [
    {
      event: 'ops.last_approver_removed',
      action: 'fees.manage,staff.manage',
      requestedBy: owner,
    },
  ]);
  assert.equal((await mailTo('staff_last_approver_removed', owner)).length, 1);
  const [issue] = await q(
    `SELECT * FROM issues WHERE kind = 'staff_last_approver_removed' AND subject->>'userId' = $1`,
    [owner],
  );
  assert.ok(issue.summary.includes('fees.manage'));
  // It records their own act: as with acting alone, someone else closes it.
  await assert.rejects(
    ops.resolveIssue(database.db, {
      issueId: issue.id,
      staffUserId: owner,
      reason: 'Closing my own alert quietly',
    }),
    refusedWith('ISSUE_OWN_ALERT'),
  );
});

test('the pending alert reaches the webhook point', async () => {
  const told = [];
  const asker = randomUUID();
  await handleDomainEvent(
    'ops.approval_pending',
    {
      action: ACTION,
      requestedBy: asker,
      requestId: randomUUID(),
      permission: 'fees.manage',
    },
    {
      db: database.db,
      logger: { info() {}, warn() {}, error() {} },
      dedupeKey: `ops.approval_pending.${randomUUID()}`,
      sealing,
      pretendPayment: true,
      postStaffAlert: async (alert) => told.push(alert),
    },
  );
  assert.deepEqual(told, [
    { event: 'ops.approval_pending', action: ACTION, requestedBy: asker },
  ]);
});

test('every serious action names a sensitive permission, and registration must match it', () => {
  const { SERIOUS_ACTIONS, SERIOUS_ACTION_PERMISSIONS, OPS_CATALOGUE } =
    contracts;
  for (const action of SERIOUS_ACTIONS)
    assert.equal(
      OPS_CATALOGUE[SERIOUS_ACTION_PERMISSIONS[action]]?.sensitive,
      true,
      action,
    );
  assert.throws(
    () =>
      registerSeriousAction({
        name: 'fee.change',
        permission: 'audit.view',
        validate: async () => {},
        describe: async () => '',
        run: async () => {},
      }),
    /fee\.change/,
  );
});

// ---- The routes ----

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const errorCode = async (response) => (await response.json()).error.code;

test('the routes: list without the payload, approve with a code, reject, cancel', async () => {
  const signedIn = await opsSignIn(stack.api, database.db, '+2348037770901');
  const [{ id: approverId }] = await q(
    `SELECT id FROM users WHERE phone_e164 = '+2348037770901'`,
  );
  const asker = await person();
  const id = await ask(asker, {
    payload: { value: 'x', hidden: 'PAYLOADONLY' },
  });

  const listed = await call('GET', '/v1/ops/approvals', signedIn.cookie);
  assert.equal(listed.status, 200);
  const text = await listed.text();
  assert.ok(!text.includes('PAYLOADONLY'));
  assert.equal(JSON.parse(text).data[0].id, id);
  assert.equal(
    (await call('GET', '/v1/ops/approvals?status=nonsense', signedIn.cookie))
      .status,
    400,
  );
  // Not signed in: nothing to see.
  assert.equal((await call('GET', '/v1/ops/approvals', '')).status, 404);

  const path = `/v1/ops/approvals/${id}`;
  // A code is required by the schema, whatever the session did recently.
  assert.equal(
    (await call('POST', `${path}/approve`, signedIn.cookie, {})).status,
    400,
  );
  const wrong = await call('POST', `${path}/approve`, signedIn.cookie, {
    code: '000000',
  });
  assert.equal(wrong.status, 400);
  assert.equal(await errorCode(wrong), 'CODE_INVALID');

  // A stale session can still approve: the code it enters is the proof.
  await q(
    `UPDATE ops_sessions SET last_totp_at = now() - interval '1 hour' WHERE user_id = $1`,
    [approverId],
  );
  const code = await signedIn.nextCode();
  const approved = await call('POST', `${path}/approve`, signedIn.cookie, {
    code,
  });
  assert.equal(approved.status, 200);
  assert.deepEqual((await approved.json()).data, { status: 'approved' });
  assert.equal(runs.length, 1);
  const replay = await call('POST', `${path}/approve`, signedIn.cookie, {
    code,
  });
  assert.equal(replay.status, 409);
  assert.equal(await errorCode(replay), 'APPROVAL_CLOSED');

  // Facts that changed: it says so, and nothing ran.
  const stopped = await ask(asker, { payload: { value: 'stopped' } });
  facts.refuse = 'ROLE_NOT_FOUND';
  const stale = await call(
    'POST',
    `/v1/ops/approvals/${stopped}/approve`,
    signedIn.cookie,
    { code: await signedIn.nextCode() },
  );
  facts.refuse = null;
  assert.equal(stale.status, 409);
  const staleBody = (await stale.json()).error;
  assert.equal(staleBody.code, 'APPROVAL_STALE');
  assert.equal(staleBody.reason, 'facts_changed');
  assert.equal(runs.length, 1);

  // Rejecting takes the usual fresh code.
  const second = await ask(asker, { payload: { value: 'second' } });
  const reject = () =>
    call('POST', `/v1/ops/approvals/${second}/reject`, signedIn.cookie, {
      reason: 'That is not what the ticket asked for',
    });
  const noCode = await reject();
  assert.equal(noCode.status, 403);
  assert.equal(await errorCode(noCode), 'FRESH_CODE_REQUIRED');
  await q(`UPDATE ops_sessions SET last_totp_at = now() WHERE user_id = $1`, [
    approverId,
  ]);
  assert.equal((await reject()).status, 200);
  assert.equal((await rowOf(second)).status, 'rejected');

  // Someone else's request can't be cancelled; a bad id is a 404 either way.
  const third = await ask(asker, { payload: { value: 'third' } });
  const notMine = await call(
    'POST',
    `/v1/ops/approvals/${third}/cancel`,
    signedIn.cookie,
  );
  assert.equal(notMine.status, 403);
  assert.equal(await errorCode(notMine), 'APPROVAL_NOT_YOURS');
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/approvals/${randomUUID()}/cancel`,
        signedIn.cookie,
      )
    ).status,
    404,
  );
});

test('a person who lost a permission can still see and cancel their own request', async () => {
  const [asker] = await twoPeople();
  const id = await ask(asker);
  await q(`UPDATE staff SET role_id = $1 WHERE user_id = $2`, [
    await roleWith(['issues.view']),
    asker,
  ]);
  const [listed] = await ops.listApprovals(database.db, { actorId: asker });
  assert.equal(listed.id, id);
  await ops.cancelRequest(database.db, { requestId: id, actorId: asker });
  assert.equal((await rowOf(id)).status, 'cancelled');
});

// ---- Fix round 1 ----

const eventsOf = (type) =>
  q(`SELECT * FROM outbox_events WHERE event_type = $1`, [type]);
const handle = (name, data, extra = {}) =>
  handleDomainEvent(name, data, {
    db: database.db,
    logger: { info() {}, warn() {}, error() {} },
    dedupeKey: `${name}.${randomUUID()}`,
    sealing,
    pretendPayment: true,
    ...extra,
  });
const verifiedPerson = (options = {}) =>
  person({
    email: `p-${randomUUID()}@example.com`,
    verified: true,
    ...options,
  });

test('an approval that ran raises an event, reaches the webhook point and tells the requester', async () => {
  const asker = await verifiedPerson();
  const approver = await person();
  const id = await ask(asker);
  await approve(id, approver);
  const [event] = await eventsOf('ops.approval_ran');
  assert.equal(event.payload.requestId, id);
  assert.equal(event.payload.requestedBy, asker);
  assert.equal(event.payload.approvedBy, approver);
  const told = [];
  await handle('ops.approval_ran', event.payload, {
    dedupeKey: event.dedupe_key,
    postStaffAlert: async (alert) => told.push(alert),
  });
  assert.deepEqual(told, [
    { event: 'ops.approval_ran', action: ACTION, requestedBy: asker },
  ]);
  await waitFor(
    async () => (await mailTo('staff_approval_outcome', asker)).length === 1,
  );
});

test('the requester hears of a rejection, a stale close and an expiry, through the worker', async () => {
  const asker = await verifiedPerson();
  const other = await person();
  const rejected = await ask(asker, { payload: { value: 'a' } });
  await ops.rejectRequest(database.db, {
    requestId: rejected,
    actorId: other,
    grantId: people.get(other).grantId,
    reason: 'That is not what the ticket asked for',
  });
  const stale = await ask(asker, { payload: { value: 'b' } });
  facts.refuse = 'ROLE_NOT_FOUND';
  await approve(stale, other);
  facts.refuse = null;
  const lapsed = await ask(asker, { payload: { value: 'c' } });
  await ops.expireRequests(database.db, {
    now: new Date(Date.now() + 25 * 60 * 60 * 1000),
  });
  assert.equal((await rowOf(lapsed)).status, 'expired');
  const events = await eventsOf('ops.approval_closed');
  assert.deepEqual(events.map((e) => e.payload.outcome).sort(), [
    'expired',
    'rejected',
    'stale',
  ]);
  await waitFor(
    async () => (await mailTo('staff_approval_outcome', asker)).length === 3,
  );
  // Asking the requester to hear of their own cancel would be noise.
  const cancelled = await ask(asker, { payload: { value: 'd' } });
  await ops.cancelRequest(database.db, {
    requestId: cancelled,
    actorId: asker,
  });
  assert.equal((await eventsOf('ops.approval_closed')).length, 3);
});

test('someone an action says may not decide cannot approve, and is not a second person', async () => {
  const asker = await person();
  const limited = await person({ roleId: await roleWith(['fees.manage']) });
  const gatedAsk = (actor, extra = {}) =>
    requestSeriousAction(database.db, {
      name: 'test.gated',
      payload: { target: 't1', ...extra },
      actorId: actor,
      grantId: people.get(actor).grantId,
      reason: REASON,
    });
  // With only them as the other person, it runs alone.
  assert.equal((await gatedAsk(asker)).state, 'ran');
  const owner = await person();
  const { requestId } = await gatedAsk(asker);
  await assert.rejects(
    approve(requestId, limited),
    refusedWith('PERMISSION_NOT_HELD'),
  );
  assert.equal(await lastStep(limited), null);
  const [view] = await ops.listApprovals(database.db, { actorId: limited });
  assert.equal(view.canDecide, false);
  const [ownerView] = await ops.listApprovals(database.db, { actorId: owner });
  assert.equal(ownerView.canDecide, true);
  assert.equal((await approve(requestId, owner)).status, 'approved');
});

test('the person an action benefits cannot approve it, by id or by mailbox, and does not count', async () => {
  const asker = await person();
  const subject = await person({ email: 'bene.fit@gmail.com' });
  const twin = await person({ email: 'benefit+2@gmail.com' });
  const gatedAsk = () =>
    requestSeriousAction(database.db, {
      name: 'test.gated',
      payload: { target: 't1', subject },
      actorId: asker,
      grantId: people.get(asker).grantId,
      reason: REASON,
    });
  // Neither they nor their second account is anyone else.
  assert.equal((await gatedAsk()).state, 'ran');
  const owner = await person();
  gated.current = 'two';
  const { requestId } = await gatedAsk();
  await assert.rejects(
    approve(requestId, subject),
    refusedWith('APPROVAL_SUBJECT'),
  );
  await assert.rejects(
    approve(requestId, twin),
    refusedWith('APPROVAL_SUBJECT'),
  );
  await assert.rejects(
    ops.rejectRequest(database.db, {
      requestId,
      actorId: subject,
      grantId: people.get(subject).grantId,
      reason: 'I would rather not have this at all',
    }),
    refusedWith('APPROVAL_SUBJECT'),
  );
  assert.equal((await approve(requestId, owner)).status, 'approved');
});

test('a verified recovery address on the same mailbox is the same person', async () => {
  const withRecovery = async (recovery, options) => {
    const id = await person(options);
    await q(
      `UPDATE users SET recovery_email = $1, recovery_email_verified_at = now() WHERE id = $2`,
      [recovery, id],
    );
    return id;
  };
  const asker = await withRecovery('pat.r@gmail.com');
  const second = await person({ email: 'patr+second@gmail.com' });
  assert.deepEqual(
    await ops.qualifiedApprovers(database.db, {
      permission: 'fees.manage',
      requesterId: asker,
    }),
    [],
  );
  // People count: losing them was never losing a second person.
  await ops.removeStaff(database.db, {
    actorId: asker,
    userId: second,
    reason: 'That was a duplicate account',
  });
  assert.equal((await lastAlerts()).length, 0);

  const back = await person({ email: 'patr+third@gmail.com' });
  const other = await person();
  const id = await ask(asker);
  await assert.rejects(approve(id, back), refusedWith('APPROVAL_OWN_REQUEST'));
  assert.equal((await approve(id, other)).status, 'approved');

  // An unverified recovery address proves nothing.
  const unproven = await person({ email: 'someone.else@example.com' });
  await q(
    `UPDATE users SET recovery_email = 'quinn@example.com' WHERE id = $1`,
    [unproven],
  );
  const quinn = await person({ email: 'quinn+1@example.com' });
  assert.ok(
    (
      await ops.qualifiedApprovers(database.db, {
        permission: 'fees.manage',
        requesterId: unproven,
      })
    ).includes(quinn),
  );

  // Adding staff on that mailbox is refused, either way round.
  await assert.rejects(
    ops.addStaff(database.db, {
      actorId: other,
      email: 'patr+new@gmail.com',
      roleId: 'owner',
      reason: 'Adding them for the launch week',
      sealing,
    }),
    refusedWith('STAFF_EMAIL_TAKEN'),
  );
  await assert.rejects(
    ops.grantOwner(database.db, { email: 'patr+cli@gmail.com' }),
    refusedWith('STAFF_EMAIL_TAKEN'),
  );
  const outside = randomUUID();
  await q(
    `INSERT INTO users (id, email, email_verified_at, recovery_email, recovery_email_verified_at)
     VALUES (gen_random_uuid(), $1, now(), 'pat.r+x@gmail.com', now())`,
    [`outside-${outside}@example.com`],
  );
  await assert.rejects(
    ops.addStaff(database.db, {
      actorId: other,
      email: `outside-${outside}@example.com`,
      roleId: 'owner',
      reason: 'Adding them for the launch week',
      sealing,
    }),
    refusedWith('STAFF_EMAIL_TAKEN'),
  );
});

test("acting alone closes the requester's other requests for that action and target", async () => {
  const [asker, other] = await twoPeople();
  const payload = (target, value) => ({ target, value });
  const gatedAsk = (body) =>
    requestSeriousAction(database.db, {
      name: 'test.gated',
      payload: body,
      actorId: asker,
      grantId: people.get(asker).grantId,
      reason: REASON,
    });
  const old = await gatedAsk(payload('t1', 'old'));
  const elsewhere = await gatedAsk(payload('t2', 'old'));
  assert.equal(old.state, 'pending');
  await ops.removeStaff(database.db, {
    actorId: asker,
    userId: other,
    reason: 'They have left the company',
  });
  const alone = await gatedAsk(payload('t1', 'new'));
  assert.equal(alone.state, 'ran');
  assert.deepEqual(alone.superseded, [old.requestId]);
  const row = await rowOf(old.requestId);
  assert.equal(row.status, 'stale');
  assert.equal(row.decided_reason, 'superseded');
  assert.equal(
    (await auditOf(old.requestId, 'serious_action.stale')).length,
    1,
  );
  assert.equal((await rowOf(elsewhere.requestId)).status, 'pending');

  // With no target declared, the whole action counts as one.
  runs.length = 0;
  const third = await person();
  const plain = await ask(asker, { payload: { value: 'old' } });
  await ops.removeStaff(database.db, {
    actorId: asker,
    userId: third,
    reason: 'They have left the company',
  });
  const lone = await requestSeriousAction(database.db, {
    name: ACTION,
    payload: { value: 'new' },
    actorId: asker,
    grantId: people.get(asker).grantId,
    reason: REASON,
  });
  assert.equal(lone.state, 'ran');
  const late = await person();
  await assert.rejects(approve(plain, late), refusedWith('APPROVAL_CLOSED'));
  assert.deepEqual(
    runs.map((r) => r.payload.value),
    ['new'],
  );
});

test('a pinned current value that moves stops the action; the engine does the comparing', async () => {
  const [asker, other] = await twoPeople();
  const { requestId } = await requestSeriousAction(database.db, {
    name: 'test.gated',
    payload: { target: 't1' },
    actorId: asker,
    grantId: people.get(asker).grantId,
    reason: REASON,
  });
  assert.deepEqual((await rowOf(requestId)).pinned, { value: 'one' });
  gated.current = 'two';
  const outcome = await approve(requestId, other);
  assert.equal(outcome.status, 'stale');
  assert.equal(outcome.why, 'facts_changed');
  assert.equal(runs.length, 0);
});

test('removing or resetting the requester closes their requests, and a restored person does not revive them', async () => {
  const asker = await verifiedPerson();
  const owner = await person();
  const approver = await person();
  const id = await ask(asker);
  await ops.resetAuthenticator(database.db, {
    actorId: owner,
    userId: asker,
    reason: 'They lost their phone today',
    sealing,
  });
  const reset = await rowOf(id);
  assert.equal(reset.status, 'stale');
  assert.equal(reset.decided_reason, 'requester_reset');
  assert.equal(reset.decided_by, owner);

  const leaver = await person();
  const second = await ask(leaver);
  await ops.removeStaff(database.db, {
    actorId: owner,
    userId: leaver,
    reason: 'They have left the company',
  });
  assert.equal((await rowOf(second)).decided_reason, 'requester_removed');
  await q(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [leaver]);
  await assert.rejects(
    approve(second, approver),
    refusedWith('APPROVAL_CLOSED'),
  );

  // Someone who can't enter a code any more, however that came about.
  const midReset = await person();
  const third = await ask(midReset);
  await q(`DELETE FROM staff_totp WHERE user_id = $1`, [midReset]);
  const outcome = await approve(third, approver);
  assert.equal(outcome.status, 'stale');
  assert.equal(outcome.why, 'requester_lost_access');

  // The server command is a reset too.
  const email = `cli-${randomUUID()}@example.com`;
  const cli = await person({ email, verified: true });
  const fourth = await ask(cli);
  await ops.grantOwner(database.db, { email });
  assert.equal((await rowOf(fourth)).decided_reason, 'requester_reset');
  assert.equal(runs.length, 0);
});

test('two people asking for the same thing share one request, and the second is told', async () => {
  const [first, second] = await twoPeople();
  const a = await ask(first);
  const repeat = await requestSeriousAction(database.db, {
    name: ACTION,
    payload: { value: 'x' },
    actorId: second,
    grantId: people.get(second).grantId,
    reason: 'A different reason from the same ticket',
  });
  assert.deepEqual(repeat, { state: 'pending', requestId: a, repeat: true });
  const mine = await requestSeriousAction(database.db, {
    name: ACTION,
    payload: { value: 'x' },
    actorId: first,
    grantId: people.get(first).grantId,
    reason: 'Asking a second time with new words',
  });
  assert.equal(mine.repeat, true);
  assert.equal((await rowOf(a)).reason, REASON);
  assert.equal((await eventsOf('ops.approval_pending')).length, 1);
  assert.equal((await approve(a, second)).status, 'approved');
  assert.equal(runs.length, 1);
});

test('a stored permission that no longer matches the action closes as stale', async () => {
  const asker = await person();
  await person();
  const id = await ask(asker);
  await q(
    `UPDATE approval_requests SET permission = 'issues.view' WHERE id = $1`,
    [id],
  );
  const viewer = await person({ roleId: await roleWith(['issues.view']) });
  const outcome = await approve(id, viewer);
  assert.equal(outcome.status, 'stale');
  assert.equal(outcome.why, 'permission_changed');
  assert.equal(runs.length, 0);
});

test(
  'a run past the deadline is STAFF_ADMIN_BUSY, leaves no trace, and cannot write afterwards',
  { timeout: 40_000 },
  async () => {
    const [asker, approver] = await twoPeople();
    const id = await ask(asker, { name: 'test.waits_in_js', payload: {} });
    signal.strayRefused = false;
    const started = Date.now();
    await assert.rejects(
      approve(id, approver),
      refusedWith('STAFF_ADMIN_BUSY'),
    );
    const took = Date.now() - started;
    assert.ok(took < 16_000 && took > 14_000, `took ${took}`);
    assert.equal((await rowOf(id)).status, 'pending');
    assert.equal(await lastStep(approver), null);
    await waitFor(() => signal.strayRefused, 5000);
    assert.equal(
      (await q(`SELECT 1 FROM audit_events WHERE action = 'test.stray_write'`))
        .length,
      0,
    );
  },
);

test(
  'a run re-entering the staff-admin lock is not turned away by those queueing behind it',
  { timeout: 30_000 },
  async () => {
    const [asker, approver] = await twoPeople();
    const id = await ask(asker, { name: 'test.reenters_lock', payload: {} });
    const inRun = new Promise((resolve) => {
      signal.inRun = resolve;
    });
    const approving = approve(id, approver);
    await inRun;
    const queued = [1, 2, 3].map(() =>
      database.db
        .transaction((tx) => ops.lockStaffAdmin(tx))
        .then(
          () => 'got',
          (error) => error.code,
        ),
    );
    const outcome = await approving;
    assert.equal(outcome.status, 'approved');
    assert.deepEqual(outcome.result, { reentered: true });
    await Promise.all(queued);
  },
);

test('the guard checks a permission whenever one is present, and refuses both decorators', () => {
  const held = new Set(['issues.view']);
  assert.equal(routeAllows('issues.view', false, held), true);
  assert.equal(routeAllows('fees.manage', false, held), false);
  assert.equal(routeAllows(undefined, false, held), false);
  assert.equal(routeAllows(undefined, true, held), true);
  // Both on one route: never quietly wider than the permission.
  assert.equal(routeAllows('fees.manage', true, held), false);
  assert.equal(routeAllows('issues.view', true, held), false);
});
