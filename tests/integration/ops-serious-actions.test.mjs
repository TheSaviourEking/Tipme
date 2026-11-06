import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from '../../packages/database/node_modules/drizzle-orm/index.js';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import * as contracts from '../../packages/contracts/dist/index.js';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import {
  ISSUE_EVENT_NAMES,
  OperationError,
  autoResolveIssues,
  holdWithdrawals,
  openIssue,
  openIssueFromEvent,
  resolveIssue,
  qualifiedApprovers,
  registerSeriousAction,
  requestSeriousAction,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { AppModule } from '../../apps/api/dist/app.module.js';
import {
  OPS_ANY_STAFF,
  OPS_PERMISSION,
  OpsGuard,
} from '../../apps/api/dist/ops/ops.guard.js';
import {
  FRESH_CODE,
  FreshCodeGuard,
} from '../../apps/api/dist/ops/fresh-code.guard.js';
import { handleDomainEvent } from '../../apps/worker/dist/handlers/domain-events.js';
import {
  MAIL_SEAL_KEY,
  WEB,
  browserHeaders,
  opsSignIn,
  startStack,
} from './helpers.mjs';

const { OPS_CATALOGUE } = contracts;
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
    return { applied: payload.value };
  },
});
registerSeriousAction({
  name: 'test.slow_run',
  permission: 'fees.manage',
  validate: async () => {},
  describe: async () => 'Runs too long',
  run: async (tx) => {
    await tx.execute(sql`SELECT pg_sleep(30)`);
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

// Asked for with one permission, decided with another (changelog plan, Task 4.2).
const ASKED = 'test.asked';
registerSeriousAction({
  name: ASKED,
  permission: 'fees.manage',
  askPermission: 'issues.view',
  validate: async () => {},
  describe: async (_tx, payload) => `Asked for ${payload.value}`,
  run: async (_tx, payload, ctx) => {
    runs.push({ payload, ctx });
    return { applied: payload.value };
  },
});

const REASON = 'The provider confirmed the change by phone';
let phoneSeq = 0;
const grants = new Map();

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
  grants.set(id, await grantFor(id));
  return id;
}

/** A live admin grant on a session of its own, last given a code `minutesAgo` minutes ago. */
async function grantFor(userId, minutesAgo = 0) {
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [userId, randomBytes(32).toString('hex')],
  );
  const [{ id }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now() - make_interval(mins => $4))
     RETURNING id`,
    [userId, sessionId, randomBytes(32).toString('hex'), minutesAgo],
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
    grantId: grants.get(String(actorId).toLowerCase()) ?? randomUUID(),
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
  // The old grant is gone, not merely stale.
  assert.equal((await sensitive()).status, 404);
});

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

const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

test('every route under a sensitive permission asks for a fresh code, enforced in the right order', () => {
  const exemptions = contracts.OPS_FRESH_CODE_EXEMPT;
  assert.ok(exemptions, 'the exemptions live in the catalogue');
  const missing = [];
  const misordered = [];
  const opaque = [];
  const exempt = new Set();
  let sensitive = 0;
  for (const controller of mountedControllers()) {
    const proto = controller.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const route = `${controller.name}.${name}`;
      // A gate written in code is invisible to the decorator, so read the code too.
      const inline = [
        ...handler.toString().matchAll(/permissions\s*\.has\(\s*([^)]*)\)/g),
      ].map((match) => match[1].trim());
      const isRoute = Reflect.getMetadata('method', handler) !== undefined;
      if (!isRoute) {
        if (inline.length) opaque.push(`${route} (helper)`);
        continue;
      }
      const permission =
        Reflect.getMetadata(OPS_PERMISSION, handler) ??
        Reflect.getMetadata(OPS_PERMISSION, controller);
      if (!permission) {
        if (inline.length) opaque.push(`${route} (no permission)`);
        continue;
      }
      // A route naming several opens to any one: it needs a code only if all of them would.
      const opensTo = [permission].flat();
      for (const one of opensTo)
        assert.ok(OPS_CATALOGUE[one], `${one} not in the catalogue`);
      const names = inline.map((text) => /^'([^']+)'$/.exec(text)?.[1]);
      if (names.includes(undefined)) opaque.push(`${route} (computed)`);
      const marked = Reflect.getMetadata(FRESH_CODE, handler) === true;
      if (marked) {
        const guards = Reflect.getMetadata('__guards__', handler) ?? [];
        const fresh = guards.indexOf(FreshCodeGuard);
        if (fresh < 0 || fresh < guards.indexOf(OpsGuard))
          misordered.push(route);
      }
      const sensitiveToOpen = opensTo.every(
        (one) => OPS_CATALOGUE[one].sensitive,
      );
      if (
        !sensitiveToOpen &&
        !names.some((one) => one && OPS_CATALOGUE[one]?.sensitive)
      )
        continue;
      sensitive += 1;
      const exemption = exemptions[route];
      if (exemption) {
        exempt.add(route);
        assert.equal(marked, false, `${route} is exempt and marked`);
        assert.equal(
          exemption.verb,
          VERBS[Reflect.getMetadata('method', handler)],
          `${route}: verb`,
        );
        assert.equal(exemption.permission, permission, `${route}: permission`);
        assert.ok(exemption.reason.length > 20, `${route}: reason`);
      } else if (!marked) missing.push(route);
    }
  }
  assert.ok(sensitive > 25, `the walk found the routes (${sensitive})`);
  assert.deepEqual(missing, []);
  assert.deepEqual(misordered, []);
  assert.deepEqual(opaque, []);
  assert.deepEqual([...exempt].sort(), Object.keys(exemptions).sort());
  for (const named of [
    'OpsAccessController.audit',
    'OpsStaffController.people',
  ])
    assert.equal(exemptions[named], undefined, `${named} needs a code`);
});

test('exactly the pinned routes let any staff through, and none also names a permission', () => {
  const pinned = contracts.OPS_ANY_STAFF_ROUTES;
  assert.ok(pinned, 'the list lives in the catalogue');
  const found = new Set();
  for (const controller of mountedControllers()) {
    const proto = controller.prototype;
    const classWide = Reflect.getMetadata(OPS_ANY_STAFF, controller);
    assert.equal(classWide, undefined, `${controller.name}: per route only`);
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      if (Reflect.getMetadata(OPS_ANY_STAFF, handler) !== true) continue;
      const route = `${controller.name}.${name}`;
      found.add(route);
      assert.equal(
        Reflect.getMetadata(OPS_PERMISSION, handler) ??
          Reflect.getMetadata(OPS_PERMISSION, controller),
        undefined,
        `${route} names a permission too`,
      );
      const entry = pinned[route];
      assert.ok(entry, `${route} is not pinned`);
      assert.equal(entry.verb, VERBS[Reflect.getMetadata('method', handler)]);
      assert.ok(entry.reason.length > 20, `${route}: reason`);
      const guards = Reflect.getMetadata('__guards__', handler) ?? [];
      assert.ok(guards.includes(OpsGuard), `${route}: OpsGuard`);
      const marked = Reflect.getMetadata(FRESH_CODE, handler) === true;
      assert.equal(marked, entry.freshCode, `${route}: fresh code`);
      if (marked)
        assert.ok(
          guards.indexOf(FreshCodeGuard) > guards.indexOf(OpsGuard),
          `${route}: guard order`,
        );
    }
  }
  assert.deepEqual([...found].sort(), Object.keys(pinned).sort());
  assert.equal(found.size, 5);
});

const staleCode = (phone) =>
  q(
    `UPDATE ops_sessions SET last_totp_at = now() - interval '6 hours'
     WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)`,
    [phone],
  );
const activeHolds = async (profileId) =>
  (
    await q(
      `SELECT count(*)::int n FROM withdrawal_holds WHERE profile_id = $1 AND released_at IS NULL`,
      [profileId],
    )
  )[0].n;

test('a stale code cannot close a money issue or lift its hold; a fresh one can', async () => {
  const phone = '+2348036660902';
  const owner = await opsSignIn(stack.api, database.db, phone);
  const [{ id: profileId }] = await q(
    `SELECT id FROM profiles WHERE handle = 'ada'`,
  );
  const { id: issueId } = await openIssue(database.db, {
    dedupeKey: `test.${randomUUID()}`,
    kind: 'payment_reversed',
    subject: { profileId },
    now: new Date(),
  });
  await database.db.transaction((tx) =>
    holdWithdrawals(tx, { profileId, reason: 'reversal', issueId }),
  );
  const before = await activeHolds(profileId);
  assert.ok(before >= 1);
  await staleCode(phone);
  const close = () =>
    call('POST', `/v1/ops/issues/${issueId}/resolve`, owner.cookie, {
      reason: 'Closing this after checking the provider',
      outcome: 'written_off',
    });
  const refused = await close();
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, 'FRESH_CODE_REQUIRED');
  assert.equal(await activeHolds(profileId), before);
  assert.equal(
    (await q(`SELECT status FROM issues WHERE id = $1`, [issueId]))[0].status,
    'open',
  );
  await q(
    `UPDATE ops_sessions SET last_totp_at = now()
     WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)`,
    [phone],
  );
  assert.equal((await close()).status, 200);
});

test('the log and the staff list ask for a fresh code; screens exempted do not', async () => {
  const phone = '+2348036660903';
  const owner = await opsSignIn(stack.api, database.db, phone);
  await staleCode(phone);
  for (const path of ['/v1/ops/audit', '/v1/ops/staff']) {
    const response = await call('GET', path, owner.cookie);
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error.code, 'FRESH_CODE_REQUIRED');
  }
  assert.equal(
    (await call('GET', '/v1/ops/staff/roles', owner.cookie)).status,
    200,
  );
});

// ---- Re-entering a code ----

test('a used code is its own error and never counts towards the lockout; wrong codes still do', async () => {
  const phone = '+2348036660904';
  const owner = await opsSignIn(stack.api, database.db, phone);
  const code = await owner.nextCode();
  const grant = (value) =>
    call('POST', '/v1/ops/grant', owner.sessionCookie, { code: value });
  assert.equal((await grant(code)).status, 200);
  for (let i = 0; i < 7; i += 1) {
    const replay = await grant(code);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error.code, 'CODE_ALREADY_USED');
  }
  assert.equal(
    (
      await q(
        `SELECT 1 FROM ops_lockouts WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1) AND locked_until > now()`,
        [phone],
      )
    ).length,
    0,
  );
  // A wrong guess isn't excused by any of that.
  const statuses = [];
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 6; i += 1) statuses.push((await grant(wrong)).status);
  assert.deepEqual(statuses, [400, 400, 400, 400, 429, 429]);
});

test('re-entering a code replaces the grant and keeps its expiry, rather than stacking', async () => {
  const phone = '+2348036660905';
  const owner = await opsSignIn(stack.api, database.db, phone);
  const rows = () =>
    q(
      `SELECT expires_at, revoked_at FROM ops_sessions
       WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1) ORDER BY created_at`,
      [phone],
    );
  const [{ expires_at: original }] = await rows();
  const grant = await call('POST', '/v1/ops/grant', owner.sessionCookie, {
    code: await owner.nextCode(),
  });
  assert.equal(grant.status, 200);
  const after = await rows();
  assert.equal(after.filter((row) => !row.revoked_at).length, 1);
  const live = after.find((row) => !row.revoked_at);
  assert.equal(live.expires_at.getTime(), original.getTime());
  assert.equal((await call('GET', '/v1/ops/issues', owner.cookie)).status, 404);
  const expiry = (await grant.json()).data.expiresAt;
  assert.equal(new Date(expiry).getTime(), original.getTime());
});

test('at the default limits, staff re-entry has a per-person budget nobody else can spend', async () => {
  const defaults = await startStack({ databaseUrl: database.url });
  try {
    const [a, b] = [
      await opsSignIn(defaults.api, database.db, '+2348036660906'),
      await opsSignIn(defaults.api, database.db, '+2348036660907'),
    ];
    const code = await a.nextCode();
    const grant = (who, value) =>
      fetch(`${defaults.api}/v1/ops/grant`, {
        method: 'POST',
        headers: browserHeaders(who.sessionCookie, { origin: WEB }),
        body: JSON.stringify({ code: value }),
      });
    assert.equal((await grant(a, code)).status, 200);
    // Used codes don't lock anyone out, so they spend the budget alone. The shared per-address
    // limit is 30 an hour by default, and sign-in above already spent part of it.
    let status;
    let count = 0;
    while (count < 70) {
      status = (await grant(a, code)).status;
      count += 1;
      if (status === 429) break;
    }
    assert.equal(status, 429, `limited after ${count}`);
    assert.equal(count, 60, 'one person gets 60 an hour');
    const other = await grant(b, await b.nextCode());
    assert.equal(
      other.status,
      200,
      'someone else on that address is unaffected',
    );
  } finally {
    await defaults.stop();
  }
});

// ---- Who counts as the second person ----

test('with nobody else qualified, the action runs at once and logs that no second person was available', async () => {
  const owner = await person();
  const outcome = await ask(owner);
  assert.deepEqual(outcome, {
    state: 'ran',
    aloneReason: 'no_second_person',
    superseded: [],
    result: { applied: 'x' },
  });
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
  await open();
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
  assert.throws(
    () =>
      registerSeriousAction({
        ...entry,
        name: 'test.other',
        permission: 'issues.view',
      }),
    /not sensitive/,
  );
});

test('actions without askPermission still require the requester to hold the permission, and still run alone without a second person', async () => {
  // Holding only what some other action asks with is not enough here.
  const asker = await person({ roleId: await roleWith(['issues.view']) });
  await assert.rejects(ask(asker), { code: 'PERMISSION_NOT_HELD' });
  const owner = await person();
  const outcome = await ask(owner);
  assert.equal(outcome.state, 'ran');
  assert.equal(outcome.aloneReason, 'no_second_person');
  assert.equal(runs.length, 1);
  assert.equal((await aloneAlerts()).length, 1);
});

test('an action with askPermission: asking takes that one, deciding the other, and only someone who could act directly runs alone', async () => {
  const asker = await person({ roleId: await roleWith(['issues.view']) });
  // Nobody can decide: refused, nothing runs, nothing waits, no alert.
  await assert.rejects(ask(asker, { name: ASKED }), {
    code: 'APPROVAL_NO_APPROVER',
  });
  assert.equal(runs.length, 0);
  assert.equal((await q('SELECT 1 FROM approval_requests')).length, 0);
  assert.equal((await aloneAlerts()).length, 0);
  // Holding neither permission: refused as before.
  const outsider = await person({ roleId: await roleWith(['search.view']) });
  await assert.rejects(ask(outsider, { name: ASKED }), {
    code: 'PERMISSION_NOT_HELD',
  });
  // Someone who holds the deciding permission too still runs alone, as today.
  const owner = await person();
  await q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [owner]);
  const both = await person({
    roleId: await roleWith(['issues.view', 'fees.manage']),
  });
  const alone = await ask(both, { name: ASKED });
  assert.equal(alone.state, 'ran');
  assert.equal((await aloneAlerts()).length, 1);
  // With a decider, the asker's request waits, under the deciding permission.
  const pending = await ask(asker, { name: ASKED });
  assert.equal(pending.state, 'pending');
  const [row] = await q(`SELECT * FROM approval_requests WHERE id = $1`, [
    pending.requestId,
  ]);
  assert.equal(row.permission, 'fees.manage');
  assert.equal(row.requested_by, asker);
  assert.deepEqual(await approvers(asker), [both]);
  // The fresh code is still asserted for the asker.
  await q(
    `UPDATE ops_sessions SET last_totp_at = now() - interval '6 hours' WHERE user_id = $1`,
    [asker],
  );
  await assert.rejects(ask(asker, { name: ASKED, payload: { value: 'y' } }), {
    code: 'FRESH_CODE_REQUIRED',
  });
});

test('registering an action with an unknown askPermission throws', () => {
  assert.throws(
    () =>
      registerSeriousAction({
        name: 'test.unknown_ask',
        permission: 'fees.manage',
        askPermission: 'nothing.such',
        validate: async () => {},
        describe: async () => '',
        run: async () => {},
      }),
    /unknown ask permission/,
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

// ---- Fresh code inside the engine ----

test('the engine refuses without a fresh code on a live grant of the requester', async () => {
  const owner = await person();
  const refuse = (grantId) =>
    assert.rejects(ask(owner, { grantId }), { code: 'FRESH_CODE_REQUIRED' });
  await refuse(undefined);
  await refuse('not-a-uuid');
  await refuse(randomUUID());
  await refuse(await grantFor(owner, 6));
  const other = await person();
  await refuse(grants.get(other));
  const revoked = await grantFor(owner);
  await q(`UPDATE ops_sessions SET revoked_at = now() WHERE id = $1`, [
    revoked,
  ]);
  await refuse(revoked);
  assert.equal(runs.length, 0);
  const within = await grantFor(owner, 4);
  assert.equal((await ask(owner, { grantId: within })).state, 'pending');
});

test('a code that goes stale while the request waits on the lock is refused', async () => {
  const owner = await person();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
    );
    const asked = ask(owner);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await q(
      `UPDATE ops_sessions SET last_totp_at = now() - interval '6 minutes' WHERE id = $1`,
      [grants.get(owner)],
    );
    await client.query('COMMIT');
    await assert.rejects(asked, { code: 'FRESH_CODE_REQUIRED' });
    assert.equal(runs.length, 0);
  } finally {
    client.release();
  }
});

// ---- The lock can't take the API down ----

test('a stuck staff-admin lock gives a retryable refusal after about 5 seconds', async () => {
  const owner = await person();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
    );
    const started = Date.now();
    await assert.rejects(ask(owner), { code: 'STAFF_ADMIN_BUSY' });
    const waited = Date.now() - started;
    assert.ok(waited > 4000 && waited < 7000, `waited ${waited}ms`);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.equal(runs.length, 0);
});

test('a run that overstays its time rolls back with the same refusal', async () => {
  const owner = await person();
  const started = Date.now();
  await assert.rejects(ask(owner, { name: 'test.slow_run' }), {
    code: 'STAFF_ADMIN_BUSY',
  });
  assert.ok(Date.now() - started < 15_000);
  assert.equal((await auditFor('serious_action.ran_alone', owner)).length, 0);
});

test('public pages stay up while requests queue on the staff-admin lock', async () => {
  const owner = await opsSignIn(stack.api, database.db, '+2348036660908');
  const page = async () =>
    (
      await fetch(`${stack.api}/v1/profiles/ada`, {
        signal: AbortSignal.timeout(4000),
      })
    ).status;
  assert.equal(await page(), 200);
  const client = await database.pool.connect();
  let queued = [];
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
    );
    queued = Array.from({ length: 6 }, (_, i) =>
      call('POST', '/v1/ops/staff/roles', owner.cookie, {
        name: `Queue role ${i} ${randomUUID().slice(0, 6)}`,
        reason: 'Queueing on the lock to test the pool',
        permissions: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (let i = 0; i < 4; i += 1) assert.equal(await page(), 200);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const answers = await Promise.all(queued);
  const busy = answers.filter((answer) => answer.status === 503);
  assert.ok(busy.length >= 1, 'the overflow was told to retry');
  for (const answer of busy)
    assert.equal((await answer.json()).error.code, 'STAFF_ADMIN_BUSY');
  assert.ok(answers.every((answer) => [201, 200, 503].includes(answer.status)));
});

// ---- The alert doesn't stop at an inbox the actor controls ----

const waitFor = async (check, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out');
};
const verified = async (email, options = {}) => {
  const id = await person({ email, ...options });
  await q(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [id]);
  return id;
};
const issuesOf = (userId) =>
  q(
    `SELECT * FROM issues WHERE kind = 'staff_acted_alone' AND subject->>'userId' = $1 ORDER BY opened_at`,
    [userId],
  );

test('each lone action reaches the inbox and every owner by mail, through the worker', async () => {
  const owner = await verified(`lone-${randomUUID()}@example.com`);
  // A second owner mid-reset can't approve, so the action runs alone, but they still hear of it.
  const other = await verified(`other-${randomUUID()}@example.com`);
  await q(`UPDATE staff_totp SET confirmed_at = NULL WHERE user_id = $1`, [
    other,
  ]);
  await ask(owner);
  await ask(owner);
  // Two actions, two issues: repeats aren't swallowed.
  await waitFor(async () => (await issuesOf(owner)).length === 2);
  const mailFor = (userId) =>
    q(
      `SELECT * FROM mail_messages WHERE type = 'staff_acted_alone' AND user_id = $1`,
      [userId],
    );
  await waitFor(async () => (await mailFor(owner)).length === 2);
  // The worker sends them one after another, so this one can land a moment later.
  await waitFor(async () => (await mailFor(other)).length === 2);
});

test('the webhook has a named place to plug in, and is told of each alert', async () => {
  const told = [];
  const outcome = await handleDomainEvent(
    'ops.acted_alone',
    { action: ACTION, requestedBy: randomUUID() },
    {
      db: database.db,
      logger: { info() {}, warn() {}, error() {} },
      dedupeKey: `ops.acted_alone.${randomUUID()}`,
      sealing,
      pretendPayment: true,
      postStaffAlert: async (alert) => told.push(alert),
    },
  );
  assert.equal(outcome, 'issue_opened');
  assert.equal(told.length, 1);
  assert.equal(told[0].action, ACTION);
});

test('the person who acted alone cannot close their own alert; someone else can', async () => {
  const email = `actor-${randomUUID()}@example.com`;
  const owner = await verified(email);
  await ask(owner);
  const [issue] = await waitFor(async () => {
    const found = await issuesOf(owner);
    return found.length ? found : null;
  });
  const close = (staffUserId) =>
    resolveIssue(database.db, {
      issueId: issue.id,
      staffUserId,
      reason: 'Looked at this and it was expected',
    });
  await assert.rejects(close(owner), { code: 'ISSUE_OWN_ALERT' });
  await assert.rejects(close(owner.toUpperCase()), { code: 'ISSUE_OWN_ALERT' });
  // Their second account on the same mailbox is still them.
  const [local, domain] = email.split('@');
  const second = await person({ email: `${local}+two@${domain}` });
  await assert.rejects(close(second), { code: 'ISSUE_OWN_ALERT' });
  const colleague = await person({
    email: `colleague-${randomUUID()}@example.com`,
  });
  await close(colleague);
  assert.equal(
    (await q(`SELECT status FROM issues WHERE id = $1`, [issue.id]))[0].status,
    'resolved',
  );
});

test('an alert nobody else can close closes itself after 30 days, on the record', async () => {
  const owner = await person();
  await ask(owner);
  const [issue] = await waitFor(async () => {
    const found = await issuesOf(owner);
    return found.length ? found : null;
  });
  const now = new Date();
  await autoResolveIssues(database.db, now);
  assert.equal(
    (await q(`SELECT status FROM issues WHERE id = $1`, [issue.id]))[0].status,
    'open',
  );
  await autoResolveIssues(
    database.db,
    new Date(now.getTime() + 31 * 86_400_000),
  );
  assert.equal(
    (await q(`SELECT status FROM issues WHERE id = $1`, [issue.id]))[0].status,
    'resolved',
  );
  const [row] = await q(
    `SELECT * FROM audit_events WHERE action = 'issue.auto_resolved' AND subject_id = $1`,
    [issue.id],
  );
  assert.match(row.reason, /30 days/);
  assert.equal(row.staff_user_id, null);
});

// ---- Payloads ----

test('a payload is plain JSON on both paths, and holds no secrets', async () => {
  const owner = await person();
  const when = new Date('2026-11-01T10:00:00Z');
  await ask(owner, { payload: { value: 'x', at: when, gone: undefined } });
  assert.deepEqual(runs[0].payload, {
    value: 'x',
    at: when.toISOString(),
  });
  for (const payload of [
    { code: '123456' },
    { enrolmentCode: 'abc' },
    { nested: { accessToken: 't' } },
    { list: [{ SECRET: 's' }] },
    undefined,
    { amount: 10n },
  ])
    await assert.rejects(ask(owner, { payload }), { code: 'INVALID_INPUT' });
  assert.equal(runs.length, 1);
});
