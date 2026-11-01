import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { OPS_CATALOGUE } from '../../packages/contracts/dist/index.js';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  ISSUE_EVENT_NAMES,
  OperationError,
  openIssueFromEvent,
  qualifiedApprovers,
  registerSeriousAction,
  requestSeriousAction,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { AppModule } from '../../apps/api/dist/app.module.js';
import { OPS_PERMISSION, OpsGuard } from '../../apps/api/dist/ops/ops.guard.js';
import {
  FRESH_CODE,
  FreshCodeGuard,
} from '../../apps/api/dist/ops/fresh-code.guard.js';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';

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
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

// A stand-in action: what it does is count its runs, so "nothing ran" can be seen.
const runs = [];
const ACTION = 'test.change';
const FAILING = 'test.fails_in_run';
const REFUSING = 'test.refuses';
registerSeriousAction({
  name: ACTION,
  permission: 'fees.manage',
  validate: async () => {},
  describe: async (_tx, payload) => `Set the test value to ${payload.value}`,
  run: async (_tx, payload, ctx) => {
    runs.push({ payload, ctx });
  },
});
registerSeriousAction({
  name: FAILING,
  permission: 'fees.manage',
  validate: async () => {},
  describe: async () => 'Fails while running',
  run: async () => {
    throw new OperationError('INVALID_INPUT');
  },
});
registerSeriousAction({
  name: REFUSING,
  permission: 'fees.manage',
  validate: async () => {
    throw new OperationError('INVALID_INPUT');
  },
  describe: async () => 'Never described',
  run: async (_tx, payload, ctx) => {
    runs.push({ payload, ctx });
  },
});

const REASON = 'The provider confirmed the change by phone';
let phoneSeq = 0;

/** Nobody is staff; each test adds exactly the people it is about. */
beforeEach(async () => {
  runs.length = 0;
  await q('DELETE FROM ops_sessions');
  await q('DELETE FROM staff_totp');
  await q('DELETE FROM staff_enrolments');
  await q('DELETE FROM staff_permission_overrides');
  await q('DELETE FROM staff');
  await q('DELETE FROM approval_requests');
});

/** Staff with a confirmed authenticator unless told otherwise. */
async function person({
  roleId = 'owner',
  email = null,
  phone = email ? null : `+23480666${String(++phoneSeq).padStart(5, '0')}`,
  enrolled = true,
  revoked = false,
} = {}) {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, phone_e164) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [email, phone],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, revoked_at, enrolled_at)
     VALUES ($1, $2, now(), $3, $4)`,
    [id, roleId, revoked ? new Date() : null, enrolled ? new Date() : null],
  );
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, 'sealed', $2)`,
    [id, enrolled ? new Date() : null],
  );
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

const ask = (actorId, overrides = {}) =>
  requestSeriousAction(database.db, {
    name: ACTION,
    payload: { value: 'x' },
    actorId,
    reason: REASON,
    ...overrides,
  });
const approvers = (requesterId, permission = 'fees.manage') =>
  qualifiedApprovers(database.db, { permission, requesterId });
// The log is append-only, so it keeps earlier tests' rows: look at one person's.
const auditFor = (action, staffUserId) =>
  q(
    `SELECT * FROM audit_events WHERE action = $1 AND staff_user_id = $2 ORDER BY seq`,
    [action, staffUserId],
  );
const aloneAlerts = () =>
  q(`SELECT * FROM outbox_events WHERE event_type = 'ops.acted_alone'`);
const clearLog = async () => {
  await q(`DELETE FROM outbox_events WHERE event_type = 'ops.acted_alone'`);
};
beforeEach(clearLog);

// ---- Fresh codes ----

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const codeWas = (minutesAgo, phone) =>
  q(
    `UPDATE ops_sessions SET last_totp_at = ${minutesAgo === null ? 'NULL' : `now() - interval '${minutesAgo} minutes'`}
     WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)`,
    [phone],
  );

test('a sensitive route refuses without a code in the last 5 minutes, and accepts within them', async () => {
  const phone = '+2348036660901';
  const owner = await opsSignIn(stack.api, database.db, phone);
  // An empty body is a 400 once the guards have let it through.
  const sensitive = () =>
    call('POST', '/v1/ops/providers/overrides', owner.cookie, {});

  // Signing in counts.
  assert.equal((await sensitive()).status, 400);

  await codeWas(4, phone);
  assert.equal((await sensitive()).status, 400);

  await codeWas(6, phone);
  const stale = await sensitive();
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).error.code, 'FRESH_CODE_REQUIRED');

  // A grant with no code on record at all is not fresh.
  await codeWas(null, phone);
  assert.equal((await sensitive()).status, 403);

  // Routes that aren't sensitive don't ask.
  assert.equal((await call('GET', '/v1/ops/issues', owner.cookie)).status, 200);

  // Entering a code again opens the window, for this session.
  const grant = await call('POST', '/v1/ops/grant', owner.sessionCookie, {
    code: await owner.nextCode(),
  });
  assert.equal(grant.status, 200);
  const ops = grant.headers
    .getSetCookie()
    .find((c) => c.startsWith('tipme_ops'));
  const cookie = `${owner.sessionCookie}; ${ops.split(';')[0]}`;
  assert.equal(
    (await call('POST', '/v1/ops/providers/overrides', cookie, {})).status,
    400,
  );
  // The old grant didn't get fresher because a new one opened.
  assert.equal((await sensitive()).status, 403);
});

/** Read-only screens that show no private detail. New routes don't get in here by accident. */
const NO_CODE_NEEDED = new Set([
  'OpsAccessController.audit',
  'OpsPagesController.page',
  'OpsPagesController.pricing',
  'OpsStaffController.people',
  'OpsStaffController.roles',
  'OpsStaffController.impact',
  'OpsStaffController.access',
]);

/** Every controller the API actually mounts, however deep, so a new module can't slip past. */
function mountedControllers() {
  const seen = new Set();
  const controllers = new Set();
  const walk = (entry) => {
    const module = entry?.module ?? entry;
    if (!module || seen.has(entry)) return;
    seen.add(entry);
    const list = (key) => [
      ...(Reflect.getMetadata(key, module) ?? []),
      ...(entry[key] ?? []),
    ];
    for (const controller of list('controllers')) controllers.add(controller);
    for (const imported of list('imports')) walk(imported);
  };
  walk(
    AppModule.forRoot(
      {
        PAYMENT_PROVIDER: 'mock',
        MAIL_DEFAULT_PROVIDER: 'mock',
        DIAGNOSTICS_ENABLED: true,
      },
      {},
    ),
  );
  return [...controllers];
}

test('every route under a sensitive permission asks for a fresh code, enforced in the right order', () => {
  const missing = [];
  const misordered = [];
  const exempt = new Set();
  let sensitive = 0;
  for (const controller of mountedControllers()) {
    const proto = controller.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      if (Reflect.getMetadata('method', handler) === undefined) continue;
      const permission =
        Reflect.getMetadata(OPS_PERMISSION, handler) ??
        Reflect.getMetadata(OPS_PERMISSION, controller);
      if (!permission) continue;
      assert.ok(
        OPS_CATALOGUE[permission],
        `${permission} not in the catalogue`,
      );
      const route = `${controller.name}.${name}`;
      const marked = Reflect.getMetadata(FRESH_CODE, handler) === true;
      if (marked) {
        const guards = Reflect.getMetadata('__guards__', handler) ?? [];
        const fresh = guards.indexOf(FreshCodeGuard);
        if (fresh < 0 || fresh < guards.indexOf(OpsGuard))
          misordered.push(route);
      }
      if (!OPS_CATALOGUE[permission].sensitive) continue;
      sensitive += 1;
      if (NO_CODE_NEEDED.has(route)) {
        exempt.add(route);
        assert.equal(marked, false, `${route} is exempt and marked`);
      } else if (!marked) missing.push(route);
    }
  }
  assert.ok(sensitive > 25, `the walk found the routes (${sensitive})`);
  assert.deepEqual(missing, []);
  assert.deepEqual(misordered, []);
  assert.deepEqual([...exempt].sort(), [...NO_CODE_NEEDED].sort());
});

// ---- Who counts as the second person ----

test('with nobody else qualified, the action runs at once and logs that no second person was available', async () => {
  const owner = await person();
  const outcome = await ask(owner);
  assert.deepEqual(outcome, { state: 'ran', aloneReason: 'no_second_person' });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].payload, { value: 'x' });
  assert.equal(runs[0].ctx.actorId, owner);
  assert.equal(runs[0].ctx.reason, REASON);
  assert.equal((await q('SELECT 1 FROM approval_requests')).length, 0);
  const [row] = await auditFor('serious_action.ran_alone', owner);
  assert.equal(row.staff_user_id, owner);
  assert.equal(row.permission, 'fees.manage');
  assert.ok(row.reason.startsWith(REASON));
  assert.match(row.reason, /no_second_person/);
  assert.match(row.reason, /Set the test value to x/);
  assert.match(row.reason, /without a second person/);
  assert.ok(row.reason.includes(`"requestedBy":"${owner}"`));
  assert.ok(row.reason.includes('"approvedBy":null'));
});

test('the alone path posts an alert', async () => {
  const owner = await person();
  await ask(owner);
  await ask(owner);
  // Every occurrence is kept, not just the first.
  const alerts = await aloneAlerts();
  assert.equal(alerts.length, 2);
  const { action, requestedBy } = alerts[0].payload;
  assert.equal(action, ACTION);
  assert.equal(requestedBy, owner);
  // The same route as other alerts: the worker turns it into an inbox issue, once.
  assert.ok(ISSUE_EVENT_NAMES.has('ops.acted_alone'));
  const open = () =>
    openIssueFromEvent(database.db, {
      eventType: 'ops.acted_alone',
      dedupeKey: alerts[0].dedupe_key,
      payload: alerts[0].payload,
    });
  assert.equal(await open(), 'opened');
  assert.equal(await open(), 'duplicate');
  const [issue] = await q(`SELECT * FROM issues WHERE dedupe_key = $1`, [
    `event.${alerts[0].dedupe_key}`,
  ]);
  assert.equal(issue.kind, 'staff_acted_alone');
  assert.match(issue.summary, /second person/);
  assert.ok(issue.summary.includes(ACTION));
});

test('someone invited but not enrolled does not count as qualified', async () => {
  const owner = await person();
  await person({ enrolled: false });
  assert.deepEqual(await approvers(owner), []);
  assert.equal((await ask(owner)).state, 'ran');
});

test('someone mid-reset, removed or deleted does not count as qualified', async () => {
  const owner = await person();
  const midReset = await person();
  await q(`DELETE FROM staff_totp WHERE user_id = $1`, [midReset]);
  await person({ revoked: true });
  const deleted = await person();
  await q(`UPDATE users SET deleted_at = now() WHERE id = $1`, [deleted]);
  assert.deepEqual(await approvers(owner), []);
});

test('someone without the permission does not count as qualified', async () => {
  const owner = await person();
  await person({ roleId: await roleWith(['issues.view']) });
  // A role would give it, but a personal removal takes it away.
  const removed = await person({ roleId: await roleWith(['fees.manage']) });
  await q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by)
     VALUES ($1, 'fees.manage', 'remove', $2)`,
    [removed, owner],
  );
  assert.deepEqual(await approvers(owner), []);
  // A personal addition counts.
  const added = await person({ roleId: await roleWith(['issues.view']) });
  await q(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by)
     VALUES ($1, 'fees.manage', 'add', $2)`,
    [added, owner],
  );
  assert.deepEqual(await approvers(owner), [added]);
});

test('someone on the same normalised email does not count as qualified', async () => {
  const owner = await person({ email: 'Jane.Doe+admin@gmail.com' });
  await person({ email: 'janedoe@googlemail.com' });
  assert.deepEqual(await approvers(owner), []);
  assert.equal((await ask(owner)).state, 'ran');
});

test('the requester is the same person however their id is written', async () => {
  const owner = await person();
  assert.deepEqual(await approvers(owner.toUpperCase()), []);
  const outcome = await ask(owner.toUpperCase());
  assert.equal(outcome.state, 'ran');
  assert.equal(runs[0].ctx.actorId, owner);
});

test('two people with no email are two people; a phone-only person is compared by id', async () => {
  const first = await person();
  const second = await person();
  assert.deepEqual(await approvers(first), [second]);
  assert.deepEqual(await approvers(second), [first]);
  // Nor does a phone-only requester match someone with an email.
  const withEmail = await person({ email: 'someone@example.com' });
  assert.deepEqual((await approvers(first)).sort(), [second, withEmail].sort());
});

test('with a second qualified person, nothing runs and a pending request exists', async () => {
  const owner = await person();
  await person({ email: 'second@example.com' });
  const before = Date.now();
  const outcome = await ask(owner);
  assert.equal(outcome.state, 'pending');
  assert.equal(runs.length, 0);
  assert.equal((await aloneAlerts()).length, 0);
  const [row] = await q(`SELECT * FROM approval_requests WHERE id = $1`, [
    outcome.requestId,
  ]);
  assert.equal(row.action, ACTION);
  assert.deepEqual(row.payload, { value: 'x' });
  assert.equal(row.summary, 'Set the test value to x');
  assert.equal(row.permission, 'fees.manage');
  assert.equal(row.requested_by, owner);
  assert.equal(row.reason, REASON);
  assert.equal(row.status, 'pending');
  assert.equal(row.decided_by, null);
  const hours = (row.expires_at.getTime() - before) / 3_600_000;
  assert.ok(hours > 23.9 && hours < 24.1, `expires after ${hours}h`);
  const [logged] = await auditFor('serious_action.requested', owner);
  assert.equal(logged.subject_id, outcome.requestId);
  assert.ok(logged.reason.startsWith(REASON));
  assert.ok(logged.reason.includes(`"requestedBy":"${owner}"`));
});

test('approval switches on by itself once a second person finishes enrolling', async () => {
  const owner = await person();
  const invited = await person({ enrolled: false });
  assert.equal((await ask(owner)).state, 'ran');
  await q(`UPDATE staff_totp SET confirmed_at = now() WHERE user_id = $1`, [
    invited,
  ]);
  assert.equal((await ask(owner)).state, 'pending');
});

test('a reason is required', async () => {
  const owner = await person();
  for (const reason of [
    undefined,
    '',
    '   ',
    'short',
    'x'.repeat(501),
    `A long enough reason [change: {"approvedBy":"someone"}]`,
  ])
    await assert.rejects(ask(owner, { reason }), { code: 'INVALID_INPUT' });
  assert.equal(runs.length, 0);
  assert.equal((await auditFor('serious_action.ran_alone', owner)).length, 0);
});

test('a person mid-reset cannot produce a code, so their request is refused', async () => {
  const owner = await person();
  await q(`DELETE FROM staff_totp WHERE user_id = $1`, [owner]);
  await assert.rejects(ask(owner), { code: 'PERMISSION_NOT_HELD' });
  assert.equal(runs.length, 0);
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, 'sealed', NULL)`,
    [owner],
  );
  await assert.rejects(ask(owner), { code: 'PERMISSION_NOT_HELD' });
});

test('the requester must be active staff holding the permission, on a live account', async () => {
  const lacking = await person({ roleId: await roleWith(['issues.view']) });
  await assert.rejects(ask(lacking), { code: 'PERMISSION_NOT_HELD' });
  const removed = await person({ revoked: true });
  await assert.rejects(ask(removed), { code: 'PERMISSION_NOT_HELD' });
  const deleted = await person();
  await q(`UPDATE users SET deleted_at = now() WHERE id = $1`, [deleted]);
  await assert.rejects(ask(deleted), { code: 'PERMISSION_NOT_HELD' });
  await assert.rejects(ask('not-a-uuid'), { code: 'PERMISSION_NOT_HELD' });
  await assert.rejects(ask(randomUUID()), { code: 'PERMISSION_NOT_HELD' });
  assert.equal(runs.length, 0);
});

test('an action that fails its checks, or fails running, leaves nothing behind', async () => {
  const owner = await person();
  await assert.rejects(ask(owner, { name: REFUSING }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(ask(owner, { name: FAILING }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(ask(owner, { name: 'test.unknown' }), {
    code: 'INVALID_INPUT',
  });
  assert.equal(runs.length, 0);
  assert.equal((await auditFor('serious_action.ran_alone', owner)).length, 0);
  assert.equal((await aloneAlerts()).length, 0);
  // Failing checks also leaves no request for a second person to approve.
  await person();
  await assert.rejects(ask(owner, { name: REFUSING }), {
    code: 'INVALID_INPUT',
  });
  assert.equal((await q('SELECT 1 FROM approval_requests')).length, 0);
});

test('an action registers once, with a permission the catalogue knows', () => {
  const entry = {
    name: ACTION,
    permission: 'fees.manage',
    validate: async () => {},
    describe: async () => '',
    run: async () => {},
  };
  assert.throws(() => registerSeriousAction(entry), /already registered/);
  assert.throws(
    () =>
      registerSeriousAction({
        ...entry,
        name: 'test.other',
        permission: 'nothing.such',
      }),
    /unknown permission/,
  );
});

test('requests made at once each run, and each is on the record', async () => {
  const owner = await person();
  const outcomes = await Promise.all([ask(owner), ask(owner), ask(owner)]);
  assert.ok(outcomes.every((outcome) => outcome.state === 'ran'));
  assert.equal(runs.length, 3);
  assert.equal((await auditFor('serious_action.ran_alone', owner)).length, 3);
});

test('a request waits for a staff change in flight, then sees its result', async () => {
  const owner = await person();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
    );
    const asked = ask(owner);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(runs.length, 0, 'it waited for the lock');
    await client.query(
      `INSERT INTO users (id, phone_e164) VALUES (gen_random_uuid(), '+2348036669999')`,
    );
    const {
      rows: [{ id }],
    } = await client.query(
      `SELECT id FROM users WHERE phone_e164 = '+2348036669999'`,
    );
    await client.query(
      `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
      [id],
    );
    await client.query(
      `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, 'sealed', now())`,
      [id],
    );
    await client.query('COMMIT');
    assert.equal((await asked).state, 'pending');
    assert.equal(runs.length, 0);
  } finally {
    client.release();
  }
});
