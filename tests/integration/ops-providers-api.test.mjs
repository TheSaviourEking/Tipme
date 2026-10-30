import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPS_PERMISSION } from '../../apps/api/dist/ops/ops.guard.js';
import { OpsProvidersController } from '../../apps/api/dist/ops/providers.controller.js';
import {
  DEMO_PROFILES,
  mailSealing,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';

const sealing = mailSealing(Buffer.alloc(32, 7));
const [ADA, TOBI] = DEMO_PROFILES;
const ops = { userId: TOBI.userId };
const reason = 'moving to the launch provider';
const SECRET = 'zepto-secret-key-value';

async function setup(t, config = {}) {
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
  );
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
    overview: 'issues.view',
    startTest: 'providers.manage',
    confirmTest: 'issues.view',
    switchProvider: 'providers.manage',
    setOverride: 'providers.manage',
    removeOverride: 'providers.manage',
    lookupSuppression: 'private.view',
    removeAddressSuppression: 'providers.manage',
  };
  for (const [method, permission] of Object.entries(expected))
    assert.equal(
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

test('an override can be set by handle and removed, and shows in the overview', async (t) => {
  const { api } = await setup(t);
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
    (await api.lookupSuppression({ address: 'a@example.com' })).data.suppression
      .reason,
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
    (await api.lookupSuppression({ address: 'a@example.com' })).data
      .suppression,
    null,
  );
});
