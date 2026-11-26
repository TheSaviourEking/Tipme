import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { totpAt } from '../../packages/domain/dist/index.js';
import { WEB, browserHeaders, opsSignIn, startStack } from './helpers.mjs';

/*
 * Fee waivers, plan Task 7 (spec 2026-11-23 §6): the ops API behind "Who pays the fees". Reading is
 * `fees.manage`; a change is the serious action `fee_waiver.set` with a fresh code and a second
 * person. Two owners are signed in, so every change here waits for the other.
 */

const REASON = 'Launch promotion agreed with the owner today';
const stale = "now() - interval '1 hour'";

let database;
let stack;
let first;
let second;
let firstId;
let secondId;

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const idOf = async (phone) =>
  (await q(`SELECT id FROM users WHERE phone_e164 = $1`, [phone]))[0].id;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
    },
  });
  first = await opsSignIn(stack.api, database.db, '+2348037771001');
  second = await opsSignIn(stack.api, database.db, '+2348037771002');
  firstId = await idOf('+2348037771001');
  secondId = await idOf('+2348037771002');
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

beforeEach(async () => {
  await q(
    `UPDATE staff SET revoked_at = now() WHERE revoked_at IS NULL AND user_id NOT IN ($1, $2)`,
    [firstId, secondId],
  );
  await q(
    `UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`,
  );
  await q(`UPDATE ops_sessions SET last_totp_at = now()`);
  await q(`DELETE FROM payment_reserve_readings`);
});

const call = (method, path, cookie = first.cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const read = async (path) => {
  const response = await call('GET', path);
  assert.equal(response.status, 200, path);
  return (await response.json()).data;
};
const approve = async (requestId) => {
  await q(`UPDATE staff_totp SET last_step = NULL WHERE user_id = $1`, [
    secondId,
  ]);
  const response = await call(
    'POST',
    `/v1/ops/approvals/${requestId}/approve`,
    second.cookie,
    { code: totpAt(second.secret, BigInt(Math.floor(Date.now() / 30_000))) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
};
const profileId = async (handle) =>
  (await q(`SELECT id FROM profiles WHERE handle_lower = $1`, [handle]))[0].id;
const newBusiness = async () => {
  const id = randomUUID();
  await q(
    `INSERT INTO businesses (id, slug, name, contact_name, contact_email, created_by)
     VALUES ($1, $2, 'The Yellow Chilli', 'Ngozi', 'ngozi@example.com', $3)`,
    [id, `chilli-${id.slice(0, 8)}`, firstId],
  );
  return id;
};
const pendingCount = async () =>
  Number(
    (
      await q(
        `SELECT count(*) AS n FROM approval_requests WHERE action = 'fee_waiver.set' AND status = 'pending'`,
      )
    )[0].n,
  );

test('a staff member without fees.manage gets 403 on every route', async () => {
  const phone = `+23486${String(Date.now()).slice(-8)}`;
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
  const ada = await profileId('ada');
  const business = await newBusiness();
  for (const [method, path, body] of [
    ['GET', '/v1/ops/fee-waivers'],
    [
      'POST',
      '/v1/ops/fee-waivers',
      {
        scope: 'account',
        kind: 'individual',
        profileId: ada,
        fee: 'tip',
        payer: 'tipme',
        reason: REASON,
      },
    ],
    ['GET', `/v1/ops/fee-waivers/profiles/${ada}`],
    ['GET', `/v1/ops/fee-waivers/businesses/${business}`],
  ]) {
    const response = await call(method, path, session.cookie, body);
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal(await pendingCount(), 0);
});

test('POST without a fresh code is refused', async () => {
  await q(`UPDATE ops_sessions SET last_totp_at = ${stale}`);
  const response = await call('POST', '/v1/ops/fee-waivers', first.cookie, {
    scope: 'account',
    kind: 'individual',
    profileId: await profileId('tobi'),
    fee: 'tip',
    payer: 'tipme',
    reason: REASON,
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FRESH_CODE_REQUIRED');
  assert.equal(await pendingCount(), 0);
});

test('the grid starts on today’s rules: no business tip fee, Giving not live, the carried-over rule not listed', async () => {
  const data = await read('/v1/ops/fee-waivers');
  for (const kind of ['individual', 'business', 'giving'])
    for (const fee of ['tip', 'withdrawal']) {
      const cell = data.grid[kind][fee];
      assert.equal(cell.payer, 'account', `${kind}.${fee}`);
      assert.equal(cell.live, kind !== 'giving', `${kind}.${fee} live`);
    }
  // Businesses have no tip fee: never a rule, whatever is stored.
  assert.deepEqual(data.grid.business.tip, {
    payer: 'account',
    ruleId: null,
    endsAt: null,
    live: true,
  });
  // The reset's carried-over business rule (the switch was off) is "account pays": the default, so
  // the grid points at it but the list of rules in force doesn't show it as a waiver.
  assert.equal(typeof data.grid.business.withdrawal.ruleId, 'string');
  assert.equal(
    data.inForce.some(
      (rule) => rule.id === data.grid.business.withdrawal.ruleId,
    ),
    false,
  );
  assert.deepEqual(Object.keys(data.monthCost).sort(), [
    'business',
    'giving',
    'individual',
  ]);
  assert.deepEqual(data.monthCost.giving, {
    incomeGivenUpMinor: '0',
    cashPaidMinor: '0',
  });
  assert.equal(data.tipWaiversPaused, false);
  assert.deepEqual(data.waitingRequestIds, []);
});

test('an account waiver waits for a second person, then shows in force on the grid and the account view', async () => {
  const ada = await profileId('ada');
  const endsAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const asked = await call('POST', '/v1/ops/fee-waivers', first.cookie, {
    scope: 'account',
    kind: 'individual',
    profileId: ada,
    fee: 'withdrawal',
    payer: 'tipme',
    endsAt,
    reason: REASON,
  });
  assert.equal(asked.status, 202, await asked.clone().text());
  const { requestId } = (await asked.json()).data;
  const waiting = await read('/v1/ops/fee-waivers');
  assert.deepEqual(waiting.waitingRequestIds, [requestId]);
  assert.equal(
    waiting.inForce.some((rule) => rule.profileId === ada),
    false,
  );
  const before = await read(`/v1/ops/fee-waivers/profiles/${ada}`);
  assert.deepEqual(before.withdrawal, {
    setting: 'inherit',
    endsAt: null,
    effective: 'normal',
    ruleId: null,
  });

  assert.equal((await approve(requestId)).status, 'approved');
  const data = await read('/v1/ops/fee-waivers');
  assert.deepEqual(data.waitingRequestIds, []);
  // One account's rule doesn't change the kind-wide grid.
  assert.equal(data.grid.individual.withdrawal.payer, 'account');
  const rule = data.inForce.find((r) => r.profileId === ada);
  assert.ok(rule, JSON.stringify(data.inForce));
  assert.deepEqual(
    { ...rule, id: typeof rule.id, startsAt: typeof rule.startsAt },
    {
      id: 'string',
      scope: 'account',
      kind: 'individual',
      profileId: ada,
      businessId: null,
      handle: 'ada',
      businessName: null,
      fee: 'withdrawal',
      payer: 'tipme',
      startsAt: 'string',
      endsAt,
      setBy: firstId,
      approvedBy: secondId,
      reason: REASON,
      cost: { incomeGivenUpMinor: '0', cashPaidMinor: '0' },
    },
  );
  const account = await read(`/v1/ops/fee-waivers/profiles/${ada}`);
  assert.deepEqual(account.withdrawal, {
    setting: 'tipme',
    endsAt,
    effective: 'tipme',
    ruleId: rule.id,
  });
  assert.equal(account.tip.setting, 'inherit');
  assert.equal(account.tip.effective, 'normal');

  // Cost so far: a withdrawal paid under the rule is TipMe's cash, on the rule, the account and
  // the month.
  await q(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
       request_fingerprint, paid_at, fee_waiver_id, waived_fee_minor)
     VALUES (gen_random_uuid(), $1, 'NGN', 300000, 'PAID', $2, $2, now(), $3, 5000)`,
    [ada, randomUUID(), rule.id],
  );
  const costed = await read('/v1/ops/fee-waivers');
  assert.deepEqual(costed.inForce.find((r) => r.id === rule.id).cost, {
    incomeGivenUpMinor: '0',
    cashPaidMinor: '5000',
  });
  assert.deepEqual(costed.monthCost.individual, {
    incomeGivenUpMinor: '0',
    cashPaidMinor: '5000',
  });
  assert.deepEqual(
    (await read(`/v1/ops/fee-waivers/profiles/${ada}`)).monthCost,
    { incomeGivenUpMinor: '0', cashPaidMinor: '5000' },
  );

  // Back to the global setting: an `inherit` row is no rule, so it leaves the list (spec §4).
  const ended = await call('POST', '/v1/ops/fee-waivers', first.cookie, {
    scope: 'account',
    kind: 'individual',
    profileId: ada,
    fee: 'withdrawal',
    payer: 'inherit',
    reason: REASON,
  });
  assert.equal(ended.status, 202, await ended.clone().text());
  assert.equal(
    (await approve((await ended.json()).data.requestId)).status,
    'approved',
  );
  const after = await read('/v1/ops/fee-waivers');
  assert.equal(
    after.inForce.some((r) => r.profileId === ada),
    false,
    JSON.stringify(after.inForce),
  );
  const back = await read(`/v1/ops/fee-waivers/profiles/${ada}`);
  assert.equal(back.withdrawal.setting, 'inherit');
  assert.equal(back.withdrawal.effective, 'normal');
});

test('a kind-wide TipMe-pays request without confirmCost is refused FEE_WAIVER_CONFIRM_REQUIRED', async () => {
  const body = {
    scope: 'kind',
    kind: 'individual',
    fee: 'withdrawal',
    payer: 'tipme',
    reason: REASON,
  };
  // Two days ago Tobi paid ₦50 on a withdrawal: the last 30 whole Lagos days' cost of waiving it.
  await q(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, fee_payer, user_fee_minor,
       status, idempotency_key, request_fingerprint, paid_at, created_at)
     VALUES (gen_random_uuid(), $1, 'NGN', 300000, 'user', 5000, 'PAID', $2, $2,
       now() - interval '2 days', now() - interval '2 days')`,
    [await profileId('tobi'), randomUUID()],
  );
  const refused = await call('POST', '/v1/ops/fee-waivers', first.cookie, body);
  assert.equal(refused.status, 400);
  const { error } = await refused.json();
  assert.equal(error.code, 'FEE_WAIVER_CONFIRM_REQUIRED');
  // The refusal carries the live estimate, for the screen to show and confirm.
  assert.equal(error.reason, 'confirm_cost');
  assert.equal(error.costEstimateMinor, '5000');
  const live = error.costEstimateMinor;
  assert.equal(await pendingCount(), 0);

  // A figure that isn't the live one: refused again, with the fresh figure to show and ask once more.
  const moved = await call('POST', '/v1/ops/fee-waivers', first.cookie, {
    ...body,
    confirmCost: true,
    costEstimateMinor: String(BigInt(live) + 12_345n),
  });
  assert.equal(moved.status, 400);
  const movedError = (await moved.json()).error;
  assert.equal(movedError.code, 'FEE_WAIVER_CONFIRM_REQUIRED');
  assert.equal(movedError.reason, 'estimate_moved');
  assert.equal(movedError.costEstimateMinor, live);
  assert.equal(await pendingCount(), 0);

  // The figure the screen showed, confirmed: it waits for the second person.
  const asked = await call('POST', '/v1/ops/fee-waivers', first.cookie, {
    ...body,
    confirmCost: true,
    costEstimateMinor: live,
  });
  assert.equal(asked.status, 202, await asked.clone().text());
  assert.equal(await pendingCount(), 1);
  const [request] = await q(
    `SELECT summary FROM approval_requests WHERE action = 'fee_waiver.set' AND status = 'pending'`,
  );
  assert.match(
    request.summary,
    /^TipMe pays the withdrawal fee for all individuals, with no end date \(about ₦50(\.00)? a month, last 30 days\)$/,
  );

  // Approved: the grid shows it, the list has it, and an account following the global setting gets it.
  assert.equal(
    (await approve((await asked.json()).data.requestId)).status,
    'approved',
  );
  const data = await read('/v1/ops/fee-waivers');
  const cell = data.grid.individual.withdrawal;
  assert.equal(cell.payer, 'tipme');
  assert.equal(cell.endsAt, null);
  const rule = data.inForce.find((r) => r.id === cell.ruleId);
  assert.equal(rule?.scope, 'kind');
  assert.equal(rule.handle, null);
  assert.equal(data.grid.individual.tip.payer, 'account');
  const ada = await read(
    `/v1/ops/fee-waivers/profiles/${await profileId('ada')}`,
  );
  assert.deepEqual(ada.withdrawal, {
    setting: 'inherit',
    endsAt: null,
    effective: 'tipme',
    ruleId: null,
  });
});

test('shapes the rules refuse are refused before anything is asked', async () => {
  const ada = await profileId('ada');
  const business = await newBusiness();
  for (const body of [
    // Businesses have no tip fee.
    { scope: 'kind', kind: 'business', fee: 'tip', payer: 'tipme' },
    // A kind rule can't inherit.
    { scope: 'kind', kind: 'individual', fee: 'tip', payer: 'inherit' },
    // An account rule needs the account that matches its kind.
    { scope: 'account', kind: 'individual', fee: 'tip', payer: 'tipme' },
    {
      scope: 'account',
      kind: 'individual',
      businessId: business,
      fee: 'withdrawal',
      payer: 'tipme',
    },
    {
      scope: 'account',
      kind: 'business',
      profileId: ada,
      fee: 'withdrawal',
      payer: 'tipme',
    },
    // A kind-wide rule has no account.
    {
      scope: 'kind',
      kind: 'individual',
      profileId: ada,
      fee: 'tip',
      payer: 'account',
    },
    // A figure is only for a kind-wide TipMe-pays confirm.
    {
      scope: 'account',
      kind: 'individual',
      profileId: ada,
      fee: 'tip',
      payer: 'tipme',
      confirmCost: true,
      costEstimateMinor: '0',
    },
    // Unknown fields.
    {
      scope: 'account',
      kind: 'individual',
      profileId: ada,
      fee: 'tip',
      payer: 'tipme',
      amountMinor: '1',
    },
  ]) {
    const response = await call('POST', '/v1/ops/fee-waivers', first.cookie, {
      ...body,
      reason: REASON,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(
      (await response.json()).error.code,
      'VALIDATION_FAILED',
      JSON.stringify(body),
    );
  }
  assert.equal(await pendingCount(), 0);
});

test('a low payments reserve reading shows tipWaiversPaused', async () => {
  await q(
    `INSERT INTO payment_reserve_readings
       (id, provider, currency, available_minor, threshold_minor, low, read_at)
     VALUES (gen_random_uuid(), 'mock', 'NGN', 10000, 100000, true, now())`,
  );
  assert.equal((await read('/v1/ops/fee-waivers')).tipWaiversPaused, true);
  // Another adapter's low balance pauses nothing here.
  await q(`DELETE FROM payment_reserve_readings`);
  await q(
    `INSERT INTO payment_reserve_readings
       (id, provider, currency, available_minor, threshold_minor, low, read_at)
     VALUES (gen_random_uuid(), 'bachs-live', 'NGN', 10000, 100000, true, now())`,
  );
  assert.equal((await read('/v1/ops/fee-waivers')).tipWaiversPaused, false);
});

test('a business account view has no tip setting', async () => {
  const business = await newBusiness();
  const data = await read(`/v1/ops/fee-waivers/businesses/${business}`);
  assert.equal(data.tip, null);
  // The carried-over kind rule says the business pays: the account follows it.
  assert.deepEqual(data.withdrawal, {
    setting: 'inherit',
    endsAt: null,
    effective: 'normal',
    ruleId: null,
  });
  assert.deepEqual(data.monthCost, {
    incomeGivenUpMinor: '0',
    cashPaidMinor: '0',
  });
});

test('an unknown or malformed account is 404', async () => {
  for (const path of [
    `/v1/ops/fee-waivers/profiles/${randomUUID()}`,
    `/v1/ops/fee-waivers/businesses/${randomUUID()}`,
    '/v1/ops/fee-waivers/profiles/not-a-uuid',
    '/v1/ops/fee-waivers/businesses/not-a-uuid',
  ]) {
    const response = await call('GET', path);
    assert.equal(response.status, 404, path);
  }
  // A page's id is not a business's.
  const ada = await profileId('ada');
  assert.equal(
    (await call('GET', `/v1/ops/fee-waivers/businesses/${ada}`)).status,
    404,
  );
});

test('a lone admin’s change runs at once and answers with the new state, saying it ran alone', async () => {
  await q(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [secondId]);
  try {
    const tobi = await profileId('tobi');
    const response = await call('POST', '/v1/ops/fee-waivers', first.cookie, {
      scope: 'account',
      kind: 'individual',
      profileId: tobi,
      fee: 'tip',
      payer: 'tipme',
      reason: REASON,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const { data } = await response.json();
    assert.equal(data.actedAlone, true);
    const rule = data.inForce.find(
      (r) => r.profileId === tobi && r.fee === 'tip',
    );
    assert.equal(rule?.handle, 'tobi');
    assert.equal(rule.approvedBy, null);
    assert.deepEqual(data.waitingRequestIds, []);
  } finally {
    await q(`UPDATE staff SET revoked_at = NULL WHERE user_id = $1`, [
      secondId,
    ]);
  }
});
