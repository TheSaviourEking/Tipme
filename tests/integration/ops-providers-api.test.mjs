import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { OPS_PERMISSION } from '../../apps/api/dist/ops/ops.guard.js';
import { OpsProvidersController } from '../../apps/api/dist/ops/providers.controller.js';
import {
  DEMO_PROFILES,
  ensureOwnerRole,
  mailSealing,
  registerRealSeriousActions,
  sealSecret,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import {
  createMailHealth,
  memoryMailHealthStore,
  redisMailHealthStore,
} from '../../packages/mail/dist/index.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  browserHeaders,
  openEventStream,
  opsSignIn,
  startStack,
} from './helpers.mjs';

const sealing = mailSealing(Buffer.alloc(32, 7));
const [ADA, TOBI] = DEMO_PROFILES;
const ops = { userId: TOBI.userId, grantId: null };
const reason = 'moving to the launch provider';
const SECRET = 'zepto-secret-key-value';

const HEALTH = {
  threshold: 3,
  windowMs: 300_000,
  restMs: 900_000,
  trialCodes: 3,
};

async function setup(t, config = {}, { brevo = false, health } = {}) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const provider = (name, status) => ({
    name,
    capabilities: { marketing: false },
    status: async () => status,
    send: async () => ({ providerMessageId: 'x' }),
    verifyWebhook: () => ({ ok: false, reason: 'signature' }),
    apiKey: SECRET,
  });
  const providers = new Map([
    ['mock', provider('mock', { sandbox: null, detail: 'pretend' })],
    ['ses', provider('ses', { sandbox: true, detail: '200 emails a day' })],
    ...(brevo
      ? [['brevo', provider('brevo', { sandbox: false, detail: null })]]
      : []),
  ]);
  const api = new OpsProvidersController(
    {
      WEB_ORIGIN: 'https://usetipme.xyz',
      MAIL_DEFAULT_PROVIDER: 'mock',
      NODE_ENV: 'test',
      DEPLOYMENT_MODE: 'production',
      ...config,
    },
    { db: database.db },
    sealing,
    providers,
    {
      sealing,
      authCodeSecret: 'unused',
      mail: {
        production: (config.NODE_ENV ?? 'test') === 'production',
        configured: new Set(providers.keys()),
        fallback: 'mock',
        status: async (name) => providers.get(name).status(),
      },
    },
    health ??
      createMailHealth({
        store: memoryMailHealthStore(HEALTH),
        settings: HEALTH,
      }),
  );
  // Switching is a serious action: Tobi is the one owner, with a fresh code, so it runs alone.
  registerRealSeriousActions();
  await ensureOwnerRole(database.db);
  const q = (text, values) => database.pool.query(text, values);
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [TOBI.userId],
  );
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [TOBI.userId, sealSecret(Buffer.alloc(32, 9), 'SECRET')],
  );
  const session = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [TOBI.userId, randomBytes(32).toString('hex')],
  );
  const grant = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [TOBI.userId, session.rows[0].id, randomBytes(32).toString('hex')],
  );
  ops.grantId = grant.rows[0].id;
  return { ...database, api };
}

const code = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.getResponse?.()?.code ?? error.code ?? error.message;
  }
};

test('each route names the permission it needs', () => {
  const expected = {
    overview: ['issues.view', 'providers.manage'],
    startTest: 'providers.manage',
    confirmTest: ['issues.view', 'providers.manage'],
    switchProvider: 'providers.manage',
    setOverride: 'providers.manage',
    removeOverride: 'providers.manage',
    lookupSuppression: 'private.view',
    removeAddressSuppression: 'providers.manage',
    setFailover: 'providers.manage',
    clearHealth: 'providers.manage',
    retire: 'providers.manage',
  };
  for (const [method, permission] of Object.entries(expected))
    assert.deepEqual(
      Reflect.getMetadata(
        OPS_PERMISSION,
        OpsProvidersController.prototype[method],
      ),
      permission,
      method,
    );
});

test('the overview shows configured providers and never a key', async (t) => {
  const { api } = await setup(t);
  const { data } = await api.overview();
  assert.deepEqual(
    data.providers.map((p) => [p.name, p.active, p.sandbox, p.canActivate]),
    [
      ['mock', true, null, false],
      ['ses', false, true, false],
    ],
  );
  assert.ok(!JSON.stringify(data).includes(SECRET));
});

test('a provider whose status fails still appears, with its status unknown', async (t) => {
  const { api } = await setup(t);
  api.providers.get('ses').status = async () => {
    throw new Error('AccessDenied with arn:secret-detail');
  };
  const { data } = await api.overview();
  const ses = data.providers.find((p) => p.name === 'ses');
  assert.equal(ses.sandbox, null);
  assert.ok(!JSON.stringify(data).includes('secret-detail'));
});

test('switching without a confirmed test is 409 NO_CONFIRMED_TEST', async (t) => {
  const { api } = await setup(t);
  assert.equal(
    await code(api.switchProvider(ops, { provider: 'ses', reason })),
    'NO_CONFIRMED_TEST',
  );
});

test('test, confirm, switch, and the overview follows', async (t) => {
  const { api, db } = await setup(t);
  await api.startTest(ops, 'ses', { to: 'staff@example.com', reason });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  assert.equal(
    (await api.confirmTest(ops, { token: mail.data.token })).data.outcome,
    'confirmed',
  );
  const ready = (await api.overview()).data.providers.find(
    (p) => p.name === 'ses',
  );
  assert.equal(ready.canActivate, true);
  assert.equal(ready.lastTest.status, 'confirmed');
  assert.equal(ready.lastTest.targetHint, 's•••@example.com');
  await api.switchProvider(ops, { provider: 'ses', reason });
  const after = await api.overview();
  assert.equal(after.data.providers.find((p) => p.name === 'ses').active, true);
  assert.equal(after.data.reason, reason);
});

test('a test defaults to the staff member’s own confirmed email', async (t) => {
  const { api, db, pool } = await setup(t);
  assert.equal(
    await code(api.startTest(ops, 'ses', { reason })),
    'EMAIL_VERIFICATION_REQUIRED',
  );
  await pool.query(
    `UPDATE users SET email = 'tobi@example.com', email_verified_at = now() WHERE id = $1`,
    [ops.userId],
  );
  await api.startTest(ops, 'ses', { reason });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  assert.equal(mail.to, 'tobi@example.com');
});

test('an unconfigured provider cannot be tested or switched to', async (t) => {
  const { api } = await setup(t);
  assert.equal(
    await code(
      api.startTest(ops, 'zeptomail', { to: 'a@example.com', reason }),
    ),
    'NOT_FOUND',
  );
  assert.equal(
    await code(api.switchProvider(ops, { provider: 'zeptomail', reason })),
    'NOT_FOUND',
  );
});

test('production refuses the pretend provider and SES in sandbox', async (t) => {
  const { api, db } = await setup(t, { NODE_ENV: 'production' });
  await api.startTest(ops, 'ses', { to: 'staff@example.com', reason });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  await api.confirmTest(ops, { token: mail.data.token });
  assert.equal(
    await code(api.switchProvider(ops, { provider: 'ses', reason })),
    'PROVIDER_NOT_ALLOWED',
  );
});

const confirm = async (api, db, provider = 'ses') => {
  await api.startTest(ops, provider, { to: 'staff@example.com', reason });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  await api.confirmTest(ops, { token: mail.data.token });
};

test('an override can be set by handle and removed, and shows in the overview', async (t) => {
  const { api, db } = await setup(t);
  await confirm(api, db);
  await api.setOverride(ops, { account: 'ada', provider: 'ses', reason });
  const { data } = await api.overview();
  assert.deepEqual(
    data.overrides.map((o) => [o.handle, o.provider]),
    [['ada', 'ses']],
  );
  assert.equal(
    (await api.removeOverride(ops, { userId: ADA.userId, reason })).data
      .removed,
    true,
  );
  assert.deepEqual((await api.overview()).data.overrides, []);
  assert.equal(
    await code(
      api.setOverride(ops, { account: 'nobody_here', provider: 'ses', reason }),
    ),
    'NOT_FOUND',
  );
  assert.equal(
    await code(
      api.setOverride(ops, { account: 'ada', provider: 'zeptomail', reason }),
    ),
    'NOT_FOUND',
  );
});

test('suppression lookup and removal by address', async (t) => {
  const { api, pool } = await setup(t);
  const { addressHmac } = await import('../../packages/database/dist/index.js');
  await pool.query(
    `INSERT INTO mail_suppressions (address_hmac, reason) VALUES ($1, 'complaint')`,
    [addressHmac(sealing, 'a@example.com')],
  );
  assert.equal(
    (await api.lookupSuppression(ops, { address: 'a@example.com' })).data
      .suppression.reason,
    'complaint',
  );
  const body = { address: 'a@example.com', reason };
  assert.equal(
    (
      await api.removeAddressSuppression(ops, {
        ...body,
        confirmComplaint: false,
      })
    ).data.outcome,
    'complaint_needs_confirmation',
  );
  assert.equal(
    (
      await api.removeAddressSuppression(ops, {
        ...body,
        confirmComplaint: true,
      })
    ).data.outcome,
    'removed',
  );
  assert.equal(
    (await api.lookupSuppression(ops, { address: 'a@example.com' })).data
      .suppression,
    null,
  );
});

test('an override follows the same safeguards as a switch', async (t) => {
  const { api, db } = await setup(t);
  assert.equal(
    await code(
      api.setOverride(ops, { account: 'ada', provider: 'ses', reason }),
    ),
    'NO_CONFIRMED_TEST',
  );
  const live = await setup(t, { NODE_ENV: 'production' });
  await confirm(live.api, live.db);
  assert.equal(
    await code(
      live.api.setOverride(ops, { account: 'ada', provider: 'ses', reason }),
    ),
    'PROVIDER_NOT_ALLOWED',
  );
  void db;
});

test('a suppression lookup is audited, without the address', async (t) => {
  const { api, pool } = await setup(t);
  await api.lookupSuppression(ops, { address: 'someone@example.com' });
  const { rows } = await pool.query(
    `SELECT subject_id, staff_user_id FROM audit_events WHERE action = 'mail.suppression_looked_up'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].staff_user_id, ops.userId);
  assert.ok(!rows[0].subject_id.includes('someone'));
});

test('a provider that hangs cannot hang the page, and status is not fetched on every load', async (t) => {
  const { api } = await setup(t);
  let calls = 0;
  api.providers.get('ses').status = () => {
    calls += 1;
    return new Promise(() => {});
  };
  const started = Date.now();
  const { data } = await api.overview();
  assert.ok(Date.now() - started < 4000);
  assert.equal(data.providers.find((p) => p.name === 'ses').sandbox, null);
  api.providers.get('mock').status = async () => {
    calls += 100;
    return { sandbox: null, detail: null };
  };
  api.providers.get('ses').status = async () => {
    calls += 1;
    return { sandbox: true, detail: 'x' };
  };
  await api.overview();
  await api.overview();
  assert.ok(calls <= 2, `status fetched ${calls} times`);
});

// Brevo for codes and receipts (owner, 23 Nov 2026): where BREVO_TRANSACTIONAL=on puts it in the
// map, staff see it as "Brevo", test it, switch to it and pin an account to it like the others.
test('Brevo can be tested, switched to and pinned, and is labelled plainly', async (t) => {
  const { api, db, pool } = await setup(t, {}, { brevo: true });
  const card = (await api.overview()).data.providers.find(
    (p) => p.name === 'brevo',
  );
  assert.equal(card.label, 'Brevo');
  assert.equal(card.sandbox, false);
  await api.startTest(ops, 'brevo', { to: 'staff@example.com', reason });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  // The worker sends a test through the provider it tests, whichever is active.
  const pinned = await pool.query(
    'SELECT pinned_provider FROM mail_messages WHERE id = $1',
    [mail.id],
  );
  assert.equal(pinned.rows[0].pinned_provider, 'brevo');
  await api.confirmTest(ops, { token: mail.data.token });
  await api.switchProvider(ops, { provider: 'brevo', reason });
  const after = await api.overview();
  assert.equal(
    after.data.providers.find((p) => p.name === 'brevo').active,
    true,
  );
  await api.setOverride(ops, { account: 'ada', provider: 'brevo', reason });
  assert.deepEqual(
    (await api.overview()).data.overrides.map((o) => o.provider),
    ['brevo'],
  );
});

test('Brevo is unknown where BREVO_TRANSACTIONAL is off', async (t) => {
  const { api } = await setup(t);
  assert.equal(
    await code(
      api.startTest(ops, 'brevo', { to: 'staff@example.com', reason }),
    ),
    'NOT_FOUND',
  );
});

// Automatic failover (owner, 23 Nov 2026): Ops → Providers shows each provider's state and why, and
// which provider is live; staff can fix the provider (no automatic switching) or clear a trip.

test('without a fallback the page shows no failover and no health', async (t) => {
  const { api } = await setup(t, {}, { brevo: true });
  const { data } = await api.overview();
  assert.deepEqual(data.failover, {
    configured: false,
    fixed: false,
    live: 'mock',
    backup: null,
  });
  assert.ok(data.providers.every((p) => p.health === null));
});

test('a resting provider shows until when and why, and the backup is live', async (t) => {
  const health = createMailHealth({
    store: memoryMailHealthStore(HEALTH),
    settings: HEALTH,
  });
  const { api } = await setup(
    t,
    { MAIL_FALLBACK_PROVIDERS: ['brevo'] },
    { brevo: true, health },
  );
  let { data } = await api.overview();
  assert.deepEqual(data.failover, {
    configured: true,
    fixed: false,
    live: 'mock',
    backup: 'brevo',
  });
  assert.equal(
    data.providers.find((p) => p.name === 'mock').health.state,
    'healthy',
  );
  await health.tripCodes('mock', '4 of 6 codes unused in 10 min');
  ({ data } = await api.overview());
  const mock = data.providers.find((p) => p.name === 'mock').health;
  assert.equal(mock.state, 'resting');
  assert.equal(mock.kind, 'codes');
  assert.equal(mock.reason, '4 of 6 codes unused in 10 min');
  assert.ok(Date.parse(mock.until) > Date.now());
  assert.equal(data.failover.live, 'brevo');
});

test('staff clear a trip by hand, audited; clearing a healthy provider says so', async (t) => {
  const health = createMailHealth({
    store: memoryMailHealthStore(HEALTH),
    settings: HEALTH,
  });
  const { api, pool } = await setup(
    t,
    { MAIL_FALLBACK_PROVIDERS: ['brevo'] },
    { brevo: true, health },
  );
  await health.tripCodes('mock', 'x');
  assert.deepEqual((await api.clearHealth(ops, 'mock', { reason })).data, {
    cleared: true,
  });
  assert.equal((await health.snapshot(['mock'])).get('mock').state, 'healthy');
  assert.deepEqual((await api.clearHealth(ops, 'mock', { reason })).data, {
    cleared: false,
  });
  const audits = await pool.query(
    "SELECT action, subject_id, reason FROM audit_events WHERE action = 'mail_provider.health_cleared'",
  );
  assert.deepEqual(audits.rows, [
    { action: 'mail_provider.health_cleared', subject_id: 'mock', reason },
  ]);
  assert.equal(
    await code(api.clearHealth(ops, 'zeptomail', { reason })),
    'NOT_FOUND',
  );
});

test('clearing while the breaker store is down is 503, never a silent success', async (t) => {
  const down = async () => {
    throw new Error('redis down');
  };
  const health = createMailHealth({
    store: {
      fail: down,
      trip: down,
      succeed: down,
      claim: down,
      clear: down,
      read: down,
    },
    settings: HEALTH,
  });
  const { api } = await setup(
    t,
    { MAIL_FALLBACK_PROVIDERS: ['brevo'] },
    { brevo: true, health },
  );
  assert.equal(
    await code(api.clearHealth(ops, 'mock', { reason })),
    'DEPENDENCY_UNAVAILABLE',
  );
  // The page still loads, every provider in the failover group reading healthy.
  const { data } = await api.overview();
  assert.deepEqual(
    Object.fromEntries(
      data.providers.map((p) => [p.name, p.health?.state ?? null]),
    ),
    { mock: 'healthy', ses: null, brevo: 'healthy' },
  );
});

test('a fixed provider stays live whatever its state, until staff let it switch again', async (t) => {
  const health = createMailHealth({
    store: memoryMailHealthStore(HEALTH),
    settings: HEALTH,
  });
  const { api } = await setup(
    t,
    { MAIL_FALLBACK_PROVIDERS: ['brevo'] },
    { brevo: true, health },
  );
  await health.tripCodes('mock', 'x');
  assert.deepEqual((await api.setFailover(ops, { fixed: true, reason })).data, {
    fixed: true,
  });
  let { data } = await api.overview();
  assert.equal(data.failover.fixed, true);
  assert.equal(data.failover.live, 'mock');
  await api.setFailover(ops, { fixed: false, reason });
  ({ data } = await api.overview());
  assert.equal(data.failover.fixed, false);
  assert.equal(data.failover.live, 'brevo');
});

// Fix round 1 (review, 23 Nov 2026).

test('M6: fixing and clearing are rate-limited like a switch', async () => {
  const { RATE_LIMIT_ROUTE } =
    await import('../../apps/api/dist/checkout/rate-limit.guard.js');
  for (const method of ['switchProvider', 'setFailover', 'clearHealth'])
    assert.equal(
      Reflect.getMetadata(
        RATE_LIMIT_ROUTE,
        OpsProvidersController.prototype[method],
      ),
      'ops_request',
      method,
    );
});

test('M5: a clear whose audit row cannot be written leaves the provider resting', async (t) => {
  const health = createMailHealth({
    store: memoryMailHealthStore(HEALTH),
    settings: HEALTH,
  });
  const { api } = await setup(
    t,
    { MAIL_FALLBACK_PROVIDERS: ['brevo'] },
    { brevo: true, health },
  );
  await health.tripCodes('mock', 'x');
  const database = api.database;
  api.database = {
    db: {
      insert: () => {
        throw new Error('database down');
      },
    },
  };
  await assert.rejects(api.clearHealth(ops, 'mock', { reason }));
  api.database = database;
  assert.equal((await health.snapshot(['mock'])).get('mock').state, 'resting');
});

test('only providers in the failover group carry a failover state', async (t) => {
  const { api } = await setup(
    t,
    { MAIL_FALLBACK_PROVIDERS: ['brevo'] },
    { brevo: true },
  );
  const { data } = await api.overview();
  const health = Object.fromEntries(
    data.providers.map((p) => [p.name, p.health?.state ?? null]),
  );
  // mock (the default) and brevo (the fallback) stand in for each other; ses is configured only.
  assert.deepEqual(health, { mock: 'healthy', ses: null, brevo: 'healthy' });
});

// Live providers screen (addendum §3.3), over HTTP: a confirmed test and a cleared provider signal
// `ops.providers.changed` to staff holding issues.view or providers.manage, and nobody else.
async function liveStack(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await ensureOwnerRole(database.db);
  registerRealSeriousActions();
  const stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      LIVE_UPDATES_ENABLED: 'true',
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
  const streams = [];
  // An open stream holds app.close() forever: streams close first.
  t.after(async () => {
    for (const stream of streams) stream.close();
    await stack.stop();
  });
  const q = (text, values = []) =>
    database.pool.query(text, values).then((result) => result.rows);
  let n = 0;
  /** A staff member holding just this one permission, with their ops stream open and ready. */
  const staffWith = async (permission) => {
    const phone = `+23481${String(Date.now()).slice(-6)}${String(++n).padStart(2, '0')}`;
    const person = await opsSignIn(stack.api, database.db, phone);
    const role = `role_${randomUUID().slice(0, 8)}`;
    await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [role]);
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [role, permission],
    );
    await q(
      `UPDATE staff SET role_id = $1 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $2)`,
      [role, phone],
    );
    const stream = await openEventStream(`${stack.api}/v1/ops/events`, {
      cookie: person.cookie,
      origin: WEB,
    });
    streams.push(stream);
    assert.equal(stream.status, 200, permission);
    await stream.waitFor(/^data: \{"type":"ready"\}$/);
    return { ...person, phone, stream };
  };
  const call = (person, path, body) =>
    fetch(`${stack.api}/v1/ops/providers${path}`, {
      method: 'POST',
      headers: browserHeaders(person.cookie),
      body: JSON.stringify(body),
    });
  /** The two who should hear it get exactly one; the announcements-only person none. */
  const expectSignal = async ({ manager, viewer, other }) => {
    const changed = /^data: \{"type":"ops\.providers\.changed"\}$/;
    await manager.stream.waitFor(changed);
    await viewer.stream.waitFor(changed);
    // A beat for a duplicate, or a wrong delivery, to arrive: then there must be none.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const count = (stream) =>
      stream.frames.filter((f) => changed.test(f)).length;
    assert.equal(count(manager.stream), 1);
    assert.equal(count(viewer.stream), 1);
    assert.equal(count(other.stream), 0);
  };
  return { ...database, stack, q, staffWith, call, expectSignal };
}

test('confirming a test reaches providers staff', async (t) => {
  const s = await liveStack(t);
  const manager = await s.staffWith('providers.manage');
  const viewer = await s.staffWith('issues.view');
  const other = await s.staffWith('announcements.send');
  // A test waiting for its link, with a token this test knows.
  const token = randomBytes(32).toString('base64url');
  await s.q(
    `INSERT INTO provider_tests (id, kind, provider, started_by, started_at, target_hint, token_sha256)
     SELECT gen_random_uuid(), 'mail', 'mock', u.id, now(), 's•••@example.com', $2
       FROM users u WHERE u.phone_e164 = $1`,
    [manager.phone, createHash('sha256').update(token).digest('hex')],
  );
  const confirmed = await s.call(manager, '/tests/confirm', { token });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).data.outcome, 'confirmed');
  await s.expectSignal({ manager, viewer, other });

  // A link already used changes nothing, so it signals nothing.
  const again = await s.call(manager, '/tests/confirm', { token });
  assert.equal((await again.json()).data.outcome, 'invalid');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(
    manager.stream.frames.filter((f) => /ops\.providers\.changed/.test(f))
      .length,
    1,
  );
});

test("clearing a provider's health reaches them too", async (t) => {
  const s = await liveStack(t);
  const manager = await s.staffWith('providers.manage');
  const viewer = await s.staffWith('issues.view');
  const other = await s.staffWith('announcements.send');
  // The pretend provider tripped, in the breaker the API reads (Redis, under the stack's prefix).
  const redis = new Redis(REDIS_URL);
  t.after(() => redis.quit());
  await redisMailHealthStore(redis, {
    ...HEALTH,
    prefix: s.stack.prefix,
  }).trip('mock', Date.now(), '4 of 6 codes unused in 10 min', 'codes');
  const cleared = await s.call(manager, '/mail/mock/health/clear', { reason });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.deepEqual((await cleared.json()).data, { cleared: true });
  await s.expectSignal({ manager, viewer, other });
});
