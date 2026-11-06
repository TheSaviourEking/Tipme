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
// processing included, ₦2,000 minimum tip and withdrawal. Pro (granted by staff): the page's own
// preset amounts and minimum, never below ₦2,000.
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
  presetsMinor: ['200000', '500000', '1000000'],
  minMinor: '200000',
};

test('a Free page uses the standard amounts and v1.1 fee: 10% with processing included, ₦2,000 minimum', async () => {
  await livePage('+2348031260001', 'free_page');
  const page = await json(await call('GET', '/v1/profiles/free_page'));
  assert.deepEqual(page.tipAmounts, STANDARD);

  const tooSmall = await quote('free_page', '99999');
  assert.equal(tooSmall.status, 400);
  // No maximum: supporters tip what they want (₦25,000,000 here).
  const large = await json(await quote('free_page', '2500000000'));
  assert.equal(large.recipientNetMinor, '2250000000');
  const ok = await json(await quote('free_page', '1000000'));
  assert.equal(ok.feePolicyVersion, 'proposed-v1.1');
  assert.equal(
    BigInt(ok.platformFeeMinor) + BigInt(ok.providerFeeMinor),
    100000n,
  );
  assert.equal(ok.recipientNetMinor, '900000');
});

test('a Free recipient cannot set amounts, even by calling the API directly', async () => {
  const cookie = await livePage('+2348031260002', 'free_only');
  const response = await call('PUT', '/v1/me/tip-amounts', cookie, {
    presetsMinor: ['400000'],
    minMinor: '400000',
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
    { presetsMinor: [], minMinor: '400000' },
    {
      presetsMinor: ['400000', '600000', '800000', '1000000', '1200000'],
      minMinor: '400000',
    },
    { presetsMinor: ['300000'], minMinor: '400000' },
    { presetsMinor: ['400000'], minMinor: '100000' },
    { presetsMinor: ['200050'], minMinor: '400000' },
    { presetsMinor: ['400000', '400000'], minMinor: '400000' },
  ])
    assert.equal((await set(bad)).status, 400, JSON.stringify(bad));

  // Errors name the field that is wrong, so the form can say which one.
  const fieldsOf = async (body) =>
    (await (await set(body)).json()).error.fields;
  assert.deepEqual(
    await fieldsOf({ presetsMinor: ['300000'], minMinor: '400000' }),
    ['presetsMinor'],
  );
  assert.deepEqual(
    await fieldsOf({ presetsMinor: ['400000'], minMinor: '100000' }),
    ['minMinor'],
  );

  const saved = await set({
    presetsMinor: ['400000', '1000000', '50000000'],
    minMinor: '400000',
  });
  assert.equal(saved.status, 200);
  const own = {
    presetsMinor: ['400000', '1000000', '50000000'],
    minMinor: '400000',
  };
  assert.deepEqual((await json(saved)).tipAmounts, own);
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/pro_amounts'))).tipAmounts,
    own,
  );
  // Calling the API directly cannot get under the page's minimum.
  assert.equal((await quote('pro_amounts', '300000')).status, 400);
  assert.equal((await quote('pro_amounts', '400000')).status, 201);

  // Back to Free: the standard amounts apply again, and the page's own come back with Pro.
  await setPlan(profileId, 'free');
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/pro_amounts'))).tipAmounts,
    STANDARD,
  );
  assert.equal((await quote('pro_amounts', '300000')).status, 201);
  await setPlan(profileId, 'pro');
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/pro_amounts'))).tipAmounts,
    own,
  );
});

test('withdrawals below ₦1,000 are refused, unless they take the whole balance', async () => {
  const cookie = await livePage('+2348031260006', 'withdraw_min');
  const q = await json(await quote('withdraw_min', '400000'));
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
  assert.equal((await withdraw('200000')).status, 201);
  // NGN 800.00 is left (₦1,800 net − ₦1,000): part of it is refused, all of it is allowed,
  // so nobody is left with money they cannot withdraw (or an account they cannot close).
  const part = await withdraw('100000');
  assert.equal(part.status, 409);
  assert.equal(await code(part), 'WITHDRAWAL_TOO_SMALL');
  assert.equal((await withdraw('160000')).status, 201);
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
  // No maximum: large presets and minimums are fine.
  await update(
    `tip_presets_minor = '{200000,500000000}', min_tip_minor = 200000`,
  );
  await update(`tip_presets_minor = '{50000000}', min_tip_minor = 50000000`);
});

test('staff can find a renamed page by one of its old handles', async () => {
  const cookie = await livePage('+2348031260008', 'old_name');
  const page = await json(
    await call('GET', '/v1/ops/pages/old_name', staff.cookie),
  );
  assert.equal((await setPlan(page.profileId, 'pro')).status, 200);
  assert.equal(
    (await call('PUT', '/v1/me/handle', cookie, { handle: 'new_name' })).status,
    200,
  );
  const found = await call('GET', '/v1/ops/pages/old_name', staff.cookie);
  assert.equal(found.status, 200);
  assert.equal((await json(found)).handle, 'new_name');
});

// The starting amount ("Make it yours", PR B): a Pro page picks which of its own amounts the tip
// form starts on. Nothing about fees, the minimum or quotes changes.
async function proPage(phone, handle) {
  const cookie = await livePage(phone, handle);
  const { profileId } = await json(
    await call('GET', `/v1/ops/pages/${handle}`, staff.cookie),
  );
  await setPlan(profileId, 'pro');
  return { cookie, profileId };
}
const startColumn = async (handle) =>
  (
    await database.pool.query(
      `SELECT tip_start_minor::text AS start FROM profiles WHERE handle_lower = $1`,
      [handle],
    )
  ).rows[0].start;
const OWN = {
  presetsMinor: ['500000', '1000000', '2000000'],
  minMinor: '500000',
};

test('a Pro page chooses its starting amount; one outside its amounts is 400 with fields ["startMinor"]', async () => {
  const { cookie } = await proPage('+2348031260009', 'start_pick');
  const set = (body) => call('PUT', '/v1/me/tip-amounts', cookie, body);

  const outside = await set({ ...OWN, startMinor: '700000' });
  assert.equal(outside.status, 400);
  const error = (await outside.json()).error;
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.deepEqual(error.fields, ['startMinor']);
  assert.equal(await startColumn('start_pick'), null, 'nothing written');
  // Shape is checked before anything else: a number, or naira with kobo, is not kobo.
  assert.equal((await set({ ...OWN, startMinor: 1000000 })).status, 400);

  const saved = await set({ ...OWN, startMinor: '1000000' });
  assert.equal(saved.status, 200);
  const withStart = { ...OWN, startMinor: '1000000' };
  assert.deepEqual((await json(saved)).tipAmounts, withStart);
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/start_pick'))).tipAmounts,
    withStart,
  );
  assert.equal(await startColumn('start_pick'), '1000000');

  // Null goes back to the automatic start.
  const cleared = await set({ ...OWN, startMinor: null });
  assert.deepEqual((await json(cleared)).tipAmounts, OWN);
  assert.equal(await startColumn('start_pick'), null);
});

test('re-saving amounts without the start keeps it if still offered, and clears it if removed', async () => {
  const { cookie } = await proPage('+2348031260010', 'start_keep');
  const set = (body) => call('PUT', '/v1/me/tip-amounts', cookie, body);
  await set({ ...OWN, startMinor: '1000000' });

  // An older client that does not know about the start: the start is kept while still offered.
  const kept = await set({
    presetsMinor: ['1000000', '3000000'],
    minMinor: '500000',
  });
  assert.equal(kept.status, 200);
  assert.equal((await json(kept)).tipAmounts.startMinor, '1000000');

  const removed = await set({
    presetsMinor: ['500000', '2000000'],
    minMinor: '500000',
  });
  assert.equal(removed.status, 200);
  assert.equal((await json(removed)).tipAmounts.startMinor, undefined);
  const mine = await json(await call('GET', '/v1/me/profile', cookie));
  assert.equal(mine.tipAmounts.startMinor, undefined);
  assert.equal(await startColumn('start_keep'), null);
});

test('a Free page sending a start is refused PRO_REQUIRED; leaving Pro shows the standard amounts with no start, and returning brings it back', async () => {
  const free = await livePage('+2348031260011', 'start_free');
  const refused = await call('PUT', '/v1/me/tip-amounts', free, {
    ...STANDARD,
    startMinor: '500000',
  });
  assert.equal(refused.status, 403);
  assert.equal(await code(refused), 'PRO_REQUIRED');
  assert.equal(await startColumn('start_free'), null);

  const { cookie, profileId } = await proPage('+2348031260012', 'start_lapse');
  await call('PUT', '/v1/me/tip-amounts', cookie, {
    ...OWN,
    startMinor: '2000000',
  });
  await setPlan(profileId, 'free');
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/start_lapse'))).tipAmounts,
    STANDARD,
  );
  assert.deepEqual(
    (await json(await call('GET', '/v1/me/profile', cookie))).tipAmounts,
    STANDARD,
  );
  assert.equal(
    await startColumn('start_lapse'),
    '2000000',
    'kept, not deleted',
  );
  await setPlan(profileId, 'pro');
  assert.deepEqual(
    (await json(await call('GET', '/v1/profiles/start_lapse'))).tipAmounts,
    { ...OWN, startMinor: '2000000' },
  );
});

test('a page moved to Free between the read and the write saves no start', async () => {
  const { cookie, profileId } = await proPage('+2348031260013', 'start_race');
  await call('PUT', '/v1/me/tip-amounts', cookie, OWN);
  // Hold the row lock, so the save reads Pro and then waits on its UPDATE while staff move it to Free.
  const holder = await database.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`UPDATE profiles SET plan = 'free' WHERE id = $1`, [
      profileId,
    ]);
    const saving = call('PUT', '/v1/me/tip-amounts', cookie, {
      ...OWN,
      startMinor: '1000000',
    });
    // Let the save reach its UPDATE before the plan change commits.
    for (let i = 0; i < 50; i++) {
      const { rows } = await database.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0].n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await holder.query('COMMIT');
    const response = await saving;
    assert.equal(response.status, 403);
    assert.equal(await code(response), 'PRO_REQUIRED');
  } finally {
    holder.release();
  }
  assert.equal(await startColumn('start_race'), null);
});

test('the database refuses a start that is not one of the presets', async () => {
  await livePage('+2348031260014', 'start_guard');
  const update = (sql) =>
    database.pool.query(
      `UPDATE profiles SET ${sql} WHERE handle_lower = 'start_guard'`,
    );
  const refused = async (sql) =>
    assert.rejects(
      update(sql),
      (error) =>
        error.code === '23514' &&
        error.constraint === 'profiles_tip_start_in_presets',
      sql,
    );
  // No own amounts at all: there is nothing to start on.
  await refused(`tip_start_minor = 500000`);
  await update(
    `tip_presets_minor = '{500000,1000000}', min_tip_minor = 500000`,
  );
  await refused(`tip_start_minor = 300000`);
  await update(`tip_start_minor = 1000000`);
  // Removing the chosen amount by hand is refused too, while the start points at it.
  await refused(`tip_presets_minor = '{500000}'`);
});
