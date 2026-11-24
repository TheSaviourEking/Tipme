import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { createMockProvider } from '../../packages/payments/dist/index.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  browserHeaders,
  opsSignIn,
  startStack,
} from './helpers.mjs';

// Per-provider balances, Task 11 (spec §7): Split accounts and the provider retire check, through
// the API. Staff screens may name providers; reading one owner's balances now is audited.

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA, TOBI] = ops.DEMO_PROFILES;
const STAFF_PHONE = '+2348037781101';

let database;
let stack;
let redis;
let staff;
let staffId;

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const roleWith = async (permissions) => {
  const id = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [id]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
  return id;
};

/** One ₦4,000 tip to `handle` collected through `provider`, recorded as its webhook would. */
async function tip(provider, handle = 'tobi') {
  const { db } = database;
  const quote = await ops.createQuote(db, {
    handle,
    tipMinor: 400000n,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `${provider}_pay_${randomUUID()}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider,
    providerReference: reference,
  });
  await ops.recordProviderEvent(db, {
    provider,
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 400000n,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
}

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.ensureOwnerRole(database.db);
  await ops.seedDemoProfiles(database.db);
  const roles = { PAYMENT_WITHDRAW_ONLY_PROVIDERS: 'mock_alt' };
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000', ...roles },
    workerEnv: roles,
  });
  redis = new Redis(REDIS_URL);
  staff = await opsSignIn(stack.api, database.db, STAFF_PHONE);
  [{ id: staffId }] = await q(`SELECT id FROM users WHERE phone_e164 = $1`, [
    STAFF_PHONE,
  ]);
  // Tobi is split (a tip through each provider); Ada took tips through the active one only.
  await tip('mock_alt');
  await tip('mock');
  await tip('mock', 'ada');
});
after(async () => {
  await redis?.quit();
  await stack?.stop();
  await database?.close();
});
beforeEach(async () => {
  await q(`UPDATE staff SET role_id = 'owner' WHERE user_id = $1`, [staffId]);
});

const get = (path) =>
  fetch(`${stack.api}${path}`, { headers: { cookie: staff.cookie } });
const post = (path, body) =>
  fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers: browserHeaders(staff.cookie),
    body: JSON.stringify(body),
  });

test('a staff member without issues.view gets 403', async () => {
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    staffId,
    await roleWith(['search.view']),
  ]);
  assert.equal((await get('/v1/ops/split-accounts')).status, 403);
  assert.equal(
    (await post('/v1/ops/split-accounts/read', { profileId: TOBI.id })).status,
    403,
  );
  assert.equal((await get('/v1/ops/providers/payments/retire')).status, 403);
  // issues.view opens Split accounts, but the retire check needs providers.manage.
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    staffId,
    await roleWith(['issues.view']),
  ]);
  assert.equal((await get('/v1/ops/split-accounts')).status, 200);
  assert.equal((await get('/v1/ops/providers/payments/retire')).status, 403);
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    staffId,
    await roleWith(['providers.manage']),
  ]);
  assert.equal((await get('/v1/ops/providers/payments/retire')).status, 200);
  assert.equal((await get('/v1/ops/split-accounts')).status, 403);
});

test('split accounts list the split owner, naming each provider for staff', async () => {
  const response = await get('/v1/ops/split-accounts');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.nextCursor, null);
  assert.equal(data.items.length, 1);
  const [item] = data.items;
  assert.deepEqual(item.owner, { profileId: TOBI.id, handle: 'tobi' });
  assert.equal(
    item.ledgerMinor,
    (await ops.balanceOf(database.db, TOBI.id)).availableMinor.toString(),
  );
  assert.deepEqual(item.providers, [
    { provider: 'mock_alt', role: 'withdraw_only', queuedMinor: '0' },
    { provider: 'mock', role: 'active', queuedMinor: '0' },
  ]);
  assert.equal(item.lastCheck, null);
  assert.equal(item.openIssueId, null);
  // A cursor that isn't an owner id is refused.
  assert.equal((await get('/v1/ops/split-accounts?cursor=nope')).status, 400);
});

test('the on-demand read is audited', async () => {
  await createMockProvider({
    redis,
    prefix: stack.prefix,
    name: 'mock_alt',
  }).markPayoutBalance(TOBI.id, 372000n);
  await q(`DELETE FROM audit_events WHERE action = 'split_account.read'`);
  const response = await post('/v1/ops/split-accounts/read', {
    profileId: TOBI.id,
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data, [
    { provider: 'mock_alt', availableMinor: '372000' },
    { provider: 'mock', availableMinor: '100000000000' },
  ]);
  const rows = await q(
    `SELECT staff_user_id, permission, subject_type, subject_id FROM audit_events
      WHERE action = 'split_account.read'`,
  );
  assert.deepEqual(rows, [
    {
      staff_user_id: staffId,
      permission: 'issues.view',
      subject_type: 'profile',
      subject_id: TOBI.id,
    },
  ]);
  // Only split owners are read; a malformed body is refused before anything is read or audited.
  assert.equal(
    (await post('/v1/ops/split-accounts/read', { profileId: ADA.id })).status,
    404,
  );
  assert.equal(
    (
      await post('/v1/ops/split-accounts/read', {
        profileId: TOBI.id,
        businessId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await q(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'split_account.read'`,
      )
    )[0].n,
    1,
  );
});

test('the retire check shows the withdraw-only provider', async () => {
  const response = await get('/v1/ops/providers/payments/retire');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.retireAfterDays, 30);
  assert.equal(data.providers.length, 1);
  const [row] = data.providers;
  assert.equal(row.provider, 'mock_alt');
  // Tobi is split there and never checked: unknown is never "nothing".
  assert.equal(row.ownersWithMoney, 1);
  assert.equal(row.openPayouts, 0);
  assert.equal(row.openRefunds, 0);
  assert.equal(row.openDisputes, 0);
  // Tipped through it today: not 30 days quiet yet.
  assert.ok(row.lastActivityAt);
  assert.equal(row.canRetire, false);
});
