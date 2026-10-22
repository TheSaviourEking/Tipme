import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// Free and Pro tipping (PR-012, PRD v1.1 proposed rules; pretend money). Free: 10% fee with
// processing included, ₦1,000 minimum tip and withdrawal. Pro (granted by staff): the page's own
// preset amounts and minimum, never below ₦1,000.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let staff;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
  staff = await opsSignIn(stack.api, database.db, '+2348031260099');
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body, extra = {}) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET'
        ? cookie
          ? { cookie }
          : {}
        : browserHeaders(cookie, extra),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response) => (await response.json()).data;
const code = async (response) => (await response.json()).error.code;

async function livePage(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  assert.equal(
    (await call('POST', '/v1/me/page', cookie, { handle })).status,
    201,
  );
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  return cookie;
}

const quote = (handle, amountMinor) =>
  call('POST', '/v1/tip-quotes', undefined, {
    handle,
    amountMinor,
    currency: 'NGN',
  });

const setPlan = (profileId, plan, reason = 'Pilot recipient') =>
  call('POST', `/v1/ops/pages/${profileId}/plan`, staff.cookie, {
    plan,
    reason,
  });

const STANDARD = {
  presetsMinor: ['100000', '200000', '500000'],
  minMinor: '100000',
  maxMinor: '10000000',
};

test('a Free page uses the standard amounts and v1.1 fee: 10% with processing included, ₦1,000 minimum', async () => {
  await livePage('+2348031260001', 'free_page');
  const page = await json(await call('GET', '/v1/profiles/free_page'));
  assert.deepEqual(page.tipAmounts, STANDARD);

  const tooSmall = await quote('free_page', '99999');
  assert.equal(tooSmall.status, 400);
  const ok = await json(await quote('free_page', '500000'));
  assert.equal(ok.feePolicyVersion, 'proposed-v1.1');
  assert.equal(
    BigInt(ok.platformFeeMinor) + BigInt(ok.providerFeeMinor),
    50000n,
  );
  assert.equal(ok.recipientNetMinor, '450000');
});

test('a Free recipient cannot set amounts, even by calling the API directly', async () => {
  const cookie = await livePage('+2348031260002', 'free_only');
  const response = await call('PUT', '/v1/me/tip-amounts', cookie, {
    presetsMinor: ['200000'],
    minMinor: '200000',
  });
  assert.equal(response.status, 403);
  assert.equal(await code(response), 'PRO_REQUIRED');
  const mine = await json(await call('GET', '/v1/me/profile', cookie));
  assert.equal(mine.plan, 'free');
  assert.deepEqual(mine.tipAmounts, STANDARD);
});

test('staff make a page Pro (with a reason, audited); a recipient without the permission cannot', async () => {
  await livePage('+2348031260003', 'pro_grant');
  const found = await call('GET', '/v1/ops/pages/pro_grant', staff.cookie);
  assert.equal(found.status, 200);
  const page = await json(found);
  assert.equal(page.plan, 'free');
  assert.equal((await setPlan(page.profileId, 'pro', '')).status, 400);
  const granted = await setPlan(page.profileId, 'pro');
  assert.equal(granted.status, 200);
  assert.equal((await json(granted)).plan, 'pro');
  const { rows } = await database.pool.query(
    `SELECT action, permission, reason FROM audit_events WHERE subject_id = $1`,
    [page.profileId],
  );
  assert.deepEqual(rows, [
    {
      action: 'page.plan_pro',
      permission: 'pages.plan',
      reason: 'Pilot recipient',
    },
  ]);
  // Asking for the plan it already has (a stale screen) changes and records nothing.
  assert.equal((await setPlan(page.profileId, 'pro')).status, 200);
  const { rows: again } = await database.pool.query(
    `SELECT action FROM audit_events WHERE subject_id = $1`,
    [page.profileId],
  );
  assert.equal(again.length, 1);
  await setPlan(page.profileId, 'free', 'Pilot finished for now');
  const { rows: back } = await database.pool.query(
    `SELECT action FROM audit_events WHERE subject_id = $1 ORDER BY created_at`,
    [page.profileId],
  );
  assert.deepEqual(
    back.map((r) => r.action),
    ['page.plan_pro', 'page.plan_free'],
  );
  // Staff whose role lacks pages.plan are refused.
  const limited = await opsSignIn(stack.api, database.db, '+2348031260098');
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('viewer', 'Viewer') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'viewer' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348031260098')`,
  );
  const refused = await call(
    'POST',
    `/v1/ops/pages/${page.profileId}/plan`,
    limited.cookie,
    { plan: 'free', reason: 'Not allowed to do this' },
  );
  assert.equal(refused.status, 403);
  // An ordinary recipient session does not even see the admin (404, as every admin route).
  const recipient = await signIn(stack.api, '+2348031260004');
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/pages/${page.profileId}/plan`,
        recipient.cookie,
        { plan: 'free', reason: 'Not staff at all here' },
      )
    ).status,
    404,
  );
});

test('a Pro page sets its own presets and minimum; quotes below it are refused; invalid amounts are rejected', async () => {
  const cookie = await livePage('+2348031260005', 'pro_amounts');
  const { profileId } = await json(
    await call('GET', '/v1/ops/pages/pro_amounts', staff.cookie),
  );
  await setPlan(profileId, 'pro');
  const set = (body) => call('PUT', '/v1/me/tip-amounts', cookie, body);

  for (const bad of [
    { presetsMinor: [], minMinor: '200000' },
    {
      presetsMinor: ['200000', '300000', '400000', '500000', '600000'],
      minMinor: '200000',
    },
    { presetsMinor: ['150000'], minMinor: '200000' },
    { presetsMinor: ['200000'], minMinor: '50000' },
    { presetsMinor: ['200050'], minMinor: '200000' },
    { presetsMinor: ['200000', '200000'], minMinor: '200000' },
    { presetsMinor: ['20000000'], minMinor: '200000' },
  ])
    assert.equal((await set(bad)).status, 400, JSON.stringify(bad));

  // Errors name the field that is wrong, so the form can say which one.
  const fieldsOf = async (body) =>
    (await (await set(body)).json()).error.fields;
  assert.deepEqual(
    await fieldsOf({ presetsMinor: ['150000'], minMinor: '200000' }),
    ['presetsMinor'],
  );
  assert.deepEqual(
    await fieldsOf({ presetsMinor: ['200000'], minMinor: '50000' }),
    ['minMinor'],
  );

  const saved = await set({
    presetsMinor: ['200000', '500000', '1000000'],
    minMinor: '200000',
  });
  assert.equal(saved.status, 200);
  const own = {
    presetsMinor: ['200000', '500000', '1000000'],
    minMinor: '200000',
    maxMinor: '10000000',
  };
  assert.deepEqual((await json(saved)).tipAmounts, own);
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/pro_amounts'))).tipAmounts,
    own,
  );
  // Calling the API directly cannot get under the page's minimum.
  assert.equal((await quote('pro_amounts', '150000')).status, 400);
  assert.equal((await quote('pro_amounts', '200000')).status, 201);

  // Back to Free: the standard amounts apply again, and the page's own come back with Pro.
  await setPlan(profileId, 'free');
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/pro_amounts'))).tipAmounts,
    STANDARD,
  );
  assert.equal((await quote('pro_amounts', '150000')).status, 201);
  await setPlan(profileId, 'pro');
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/pro_amounts'))).tipAmounts,
    own,
  );
});

test('withdrawals below ₦1,000 are refused, unless they take the whole balance', async () => {
  const cookie = await livePage('+2348031260006', 'withdraw_min');
  const q = await json(await quote('withdraw_min', '200000'));
  const intent = await json(
    await call(
      'POST',
      '/v1/tip-intents',
      undefined,
      { quoteId: q.quoteId },
      { 'idempotency-key': randomUUID() },
    ),
  );
  const reference = intent.checkoutUrl.split('/mock-checkout/')[1];
  await call('POST', `/v1/mock-provider/checkout/${reference}`, undefined, {
    outcome: 'succeed',
  });
  for (let i = 0; i < 50; i++) {
    const { availableMinor } = await json(
      await call('GET', '/v1/me/dashboard', cookie),
    );
    if (BigInt(availableMinor) > 0n) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const withdraw = (amountMinor) =>
    call(
      'POST',
      '/v1/me/withdrawals',
      cookie,
      { amountMinor },
      { 'idempotency-key': randomUUID() },
    );
  const small = await withdraw('99999');
  assert.equal(small.status, 409);
  assert.equal(await code(small), 'WITHDRAWAL_TOO_SMALL');
  assert.equal((await withdraw('100000')).status, 201);
  // NGN 800.00 is left (₦1,800 net − ₦1,000): part of it is refused, all of it is allowed,
  // so nobody is left with money they cannot withdraw (or an account they cannot close).
  const part = await withdraw('50000');
  assert.equal(part.status, 409);
  assert.equal(await code(part), 'WITHDRAWAL_TOO_SMALL');
  assert.equal((await withdraw('80000')).status, 201);
  const { availableMinor } = await json(
    await call('GET', '/v1/me/dashboard', cookie),
  );
  assert.equal(availableMinor, '0');
});

test('the database itself refuses inconsistent Pro amounts (any future code path or manual SQL)', async () => {
  await livePage('+2348031260007', 'db_guard');
  const update = (sql) =>
    database.pool.query(
      `UPDATE profiles SET ${sql} WHERE handle_lower = 'db_guard'`,
    );
  const refused = async (sql) =>
    assert.rejects(update(sql), (error) => error.code === '23514', sql);
  await refused(`tip_presets_minor = '{200000}', min_tip_minor = NULL`);
  await refused(`tip_presets_minor = NULL, min_tip_minor = 200000`);
  await refused(`tip_presets_minor = '{150000}', min_tip_minor = 200000`);
  await refused(`tip_presets_minor = '{20000000}', min_tip_minor = 200000`);
  await update(`tip_presets_minor = '{200000,500000}', min_tip_minor = 200000`);
});

test('staff can find a renamed page by one of its old handles', async () => {
  const cookie = await livePage('+2348031260008', 'old_name');
  assert.equal(
    (await call('PUT', '/v1/me/handle', cookie, { handle: 'new_name' })).status,
    200,
  );
  const found = await call('GET', '/v1/ops/pages/old_name', staff.cookie);
  assert.equal(found.status, 200);
  assert.equal((await json(found)).handle, 'new_name');
});
