import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { totpAt } from '../../packages/domain/dist/index.js';
import { Redis } from './helpers.mjs';
import {
  REDIS_URL,
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

/*
 * Every serious route, through the API, with a second qualified person: it waits, nothing changes,
 * and approving through the API makes it happen. The other suites start the owner alone, where a
 * route that skipped the gate would behave the same.
 */

const REASON = 'Checked with the person on a call today';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let limited;
let redis;
let first;
let second;
let firstId;
let secondId;
const stale = "now() - interval '1 hour'";

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const idOf = async (phone) =>
  (await q(`SELECT id FROM users WHERE phone_e164 = $1`, [phone]))[0].id;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  const base = { databaseUrl: database.url };
  stack = await startStack({
    ...base,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
    },
  });
  limited = await startStack({
    ...base,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '3',
    },
  });
  redis = new Redis(REDIS_URL);
  first = await opsSignIn(stack.api, database.db, '+2348037770001');
  second = await opsSignIn(stack.api, database.db, '+2348037770002');
  firstId = await idOf('+2348037770001');
  secondId = await idOf('+2348037770002');
});
after(async () => {
  await redis?.quit();
  await limited?.stop();
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
  await q(`DELETE FROM provider_settings`);
  await q(`UPDATE profiles SET custom_fee_bps = NULL`);
});

const call = (base, method, path, cookie, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const approveThroughApi = async (requestId) => {
  await q(`UPDATE staff_totp SET last_step = NULL WHERE user_id = $1`, [
    secondId,
  ]);
  return call(
    stack.api,
    'POST',
    `/v1/ops/approvals/${requestId}/approve`,
    second.cookie,
    {
      code: totpAt(second.secret, BigInt(Math.floor(Date.now() / 30_000))),
    },
  );
};
const profile = async (handle = 'tobi') =>
  (
    await q(`SELECT id, user_id FROM profiles WHERE handle_lower = $1`, [
      handle,
    ])
  )[0];
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
const colleague = async (roleId) => {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`c.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [id, roleId],
  );
  return id;
};
const roleOf = async (userId) =>
  (await q(`SELECT role_id FROM staff WHERE user_id = $1`, [userId]))[0]
    .role_id;
const moneyIssue = async (kind = 'payment_reversed') => {
  const { id: profileId } = await profile();
  return (
    await ops.openIssue(database.db, {
      dedupeKey: `${kind}.${randomUUID()}`,
      kind,
      subject: { profileId },
      now: new Date(),
    })
  ).id;
};
const issueOutcome = async (id) =>
  (await q(`SELECT resolution_outcome FROM issues WHERE id = $1`, [id]))[0]
    .resolution_outcome;
/** A payout nothing has started, inserted directly so no job touches it. */
const stuckPayout = async () => {
  const { id: profileId } = await profile('ada');
  await q(`DELETE FROM withdrawal_holds WHERE profile_id = $1`, [profileId]);
  const payoutId = randomUUID();
  await q(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint, provider, created_at)
     VALUES ($1, $2, 'NGN', 100, 'REQUESTED', $3, 'f', 'mock', now() - interval '30 days')`,
    [payoutId, profileId, randomUUID()],
  );
  const issueId = (
    await ops.openIssue(database.db, {
      dedupeKey: `payout_unresolved.${payoutId}`,
      kind: 'payout_unresolved',
      subject: { payoutId },
      now: new Date(),
    })
  ).id;
  return { payoutId, issueId };
};
const payoutStatus = async (id) =>
  (await q(`SELECT status FROM payouts WHERE id = $1`, [id]))[0].status;

const resolving =
  (outcome, extra = {}) =>
  async () => {
    const id = await moneyIssue();
    return {
      method: 'POST',
      path: `/v1/ops/issues/${id}/resolve`,
      body: { reason: REASON, outcome, ...extra },
      happened: async () => (await issueOutcome(id)) === outcome,
    };
  };

const routes = {
  'email recovery': async () => {
    const { user_id: userId } = await profile();
    await q(
      `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
      [userId, `page.${randomUUID().slice(0, 8)}@example.com`],
    );
    await q(`DELETE FROM email_recoveries WHERE user_id = $1`, [userId]);
    return {
      method: 'POST',
      path: `/v1/ops/accounts/${userId}/email-recovery`,
      body: {
        newEmail: `new.${randomUUID().slice(0, 8)}@example.com`,
        checks: 'Matched their last three tips',
        reason: REASON,
      },
      happened: async () =>
        (await q(`SELECT 1 FROM email_recoveries WHERE user_id = $1`, [userId]))
          .length > 0,
    };
  },
  'page fee': async () => {
    const { id } = await profile();
    return {
      method: 'POST',
      path: `/v1/ops/pages/${id}/fee`,
      body: { feeBps: 321, reason: REASON },
      happened: async () =>
        (await q(`SELECT custom_fee_bps FROM profiles WHERE id = $1`, [id]))[0]
          .custom_fee_bps === 321,
    };
  },
  'fee-free tips': async () => {
    const { id } = await profile();
    await q(`DELETE FROM fee_free_credits WHERE profile_id = $1`, [id]);
    return {
      method: 'POST',
      path: `/v1/ops/pages/${id}/fee-free`,
      body: { count: 4, reason: REASON },
      happened: async () =>
        (await q(`SELECT 1 FROM fee_free_credits WHERE profile_id = $1`, [id]))
          .length > 0,
    };
  },
  'add a person on a sensitive role': async () => {
    const email = `added.${randomUUID().slice(0, 8)}@example.com`;
    return {
      method: 'POST',
      path: '/v1/ops/staff',
      body: { email, roleId: await roleWith(['fees.manage']), reason: REASON },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM staff s JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
            [email],
          )
        ).length > 0,
    };
  },
  'make someone an owner': async () => {
    const userId = await colleague(await roleWith(['search.view']));
    return {
      method: 'PUT',
      path: `/v1/ops/staff/${userId}/role`,
      body: { roleId: 'owner', reason: REASON },
      happened: async () => (await roleOf(userId)) === 'owner',
    };
  },
  'a sensitive role': async () => {
    const userId = await colleague(await roleWith(['search.view']));
    const roleId = await roleWith(['fees.manage']);
    return {
      method: 'PUT',
      path: `/v1/ops/staff/${userId}/role`,
      body: { roleId, reason: REASON },
      happened: async () => (await roleOf(userId)) === roleId,
    };
  },
  'a personal sensitive permission': async () => {
    const userId = await colleague(await roleWith(['search.view']));
    return {
      method: 'PUT',
      path: `/v1/ops/staff/${userId}/access`,
      body: { additions: ['fees.manage'], removals: [], reason: REASON },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM staff_permission_overrides WHERE user_id = $1 AND permission = 'fees.manage'`,
            [userId],
          )
        ).length > 0,
    };
  },
  'adding a sensitive permission to a role': async () => {
    const roleId = await roleWith(['search.view']);
    return {
      method: 'PATCH',
      path: `/v1/ops/staff/roles/${roleId}`,
      body: { permissions: ['search.view', 'fees.manage'], reason: REASON },
      happened: async () =>
        (
          await q(
            `SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission = 'fees.manage'`,
            [roleId],
          )
        ).length > 0,
    };
  },
  'reset an authenticator': async () => {
    const userId = await colleague(await roleWith(['search.view']));
    await q(
      `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, 'x', now())`,
      [userId],
    );
    return {
      method: 'POST',
      path: `/v1/ops/staff/${userId}/reset-authenticator`,
      body: { reason: REASON },
      happened: async () =>
        (await q(`SELECT 1 FROM staff_totp WHERE user_id = $1`, [userId]))
          .length === 0,
    };
  },
  'switch the mail provider': async () => {
    await q(
      `INSERT INTO provider_tests (id, kind, provider, started_by, started_at, status, confirmed_at)
       VALUES (gen_random_uuid(), 'mail', 'mock', $1, now(), 'confirmed', now())`,
      [firstId],
    );
    return {
      method: 'POST',
      path: '/v1/ops/providers/mail/active',
      body: { provider: 'mock', reason: REASON },
      happened: async () =>
        (await q(`SELECT 1 FROM provider_settings WHERE kind = 'mail'`))
          .length > 0,
    };
  },
  'mark a withdrawal failed': async () => {
    const { payoutId, issueId } = await stuckPayout();
    return {
      method: 'POST',
      path: `/v1/ops/issues/${issueId}/payout-mark-failed`,
      body: { reason: REASON, dashboardVerified: true },
      happened: async () => (await payoutStatus(payoutId)) === 'FAILED',
    };
  },
  'record a withdrawal as paid': async () => {
    const { payoutId, issueId } = await stuckPayout();
    const reference = `mock_out_${randomUUID()}`;
    await redis.hset(`mockprovider:${stack.prefix}:payout:${reference}`, {
      payoutId,
      amountMinor: '100',
      currency: 'NGN',
      scenario: 'payout-success',
      status: 'paid',
    });
    await redis.set(
      `mockprovider:${stack.prefix}:payout-id:${payoutId}`,
      reference,
    );
    return {
      method: 'POST',
      path: `/v1/ops/issues/${issueId}/payout-apply`,
      body: { reason: REASON, reported: 'paid' },
      happened: async () => (await payoutStatus(payoutId)) === 'PAID',
    };
  },
  'close money as written off': resolving('written_off'),
  'close money as recipient owes': resolving('recipient_owes'),
  'close money as settled by the provider': resolving('resolved_by_provider'),
};

for (const [name, setup] of Object.entries(routes)) {
  test(`${name}: answers 202, changes nothing, and happens on approval through the API`, async () => {
    const { method, path, body, happened } = await setup();
    const asked = await call(stack.api, method, path, first.cookie, body);
    assert.equal(asked.status, 202, await asked.clone().text());
    const { data } = await asked.json();
    assert.ok(data.requestId);
    assert.equal(await happened(), false, 'nothing yet');
    const approved = await approveThroughApi(data.requestId);
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.equal(await happened(), true, 'happened on approval');
  });
}

test('releasing a freeze waits too', async () => {
  const { id } = await profile();
  const frozen = await call(
    stack.api,
    'POST',
    `/v1/ops/pages/${id}/withdrawal-freeze`,
    first.cookie,
    {
      reason: REASON,
    },
  );
  assert.equal(frozen.status, 200);
  const { issueId } = (await frozen.json()).data;
  const asked = await call(
    stack.api,
    'POST',
    `/v1/ops/issues/${issueId}/resolve`,
    first.cookie,
    {
      reason: REASON,
      outcome: 'account_secured',
      bankAndSignInChecked: true,
    },
  );
  assert.equal(asked.status, 202);
  assert.equal(await issueOutcome(issueId), null);
  const { data } = await asked.json();
  assert.equal((await approveThroughApi(data.requestId)).status, 200);
  assert.equal(await issueOutcome(issueId), 'account_secured');
});

test('harmless changes apply at once: a role edit, a move to a harmless role', async () => {
  const roleId = await roleWith(['search.view']);
  const edit = await call(
    stack.api,
    'PATCH',
    `/v1/ops/staff/roles/${roleId}`,
    first.cookie,
    {
      permissions: ['search.view', 'analytics.view'],
      reason: REASON,
    },
  );
  assert.equal(edit.status, 200, await edit.clone().text());
  const userId = await colleague(await roleWith(['search.view']));
  const move = await call(
    stack.api,
    'PUT',
    `/v1/ops/staff/${userId}/role`,
    first.cookie,
    {
      roleId,
      reason: REASON,
    },
  );
  assert.equal(move.status, 200);
  assert.equal(await roleOf(userId), roleId);
});

test('I2: stopping needs no fresh code; switching back on does, and refuses until given', async () => {
  await q(`UPDATE ops_sessions SET last_totp_at = ${stale}`);
  const { id } = await profile('ada');
  const set = (paused) =>
    call(stack.api, 'POST', '/v1/ops/withdrawals-switch', first.cookie, {
      paused,
      reason: REASON,
    });
  try {
    assert.equal((await set(true)).status, 200);
    const on = await set(false);
    assert.equal(on.status, 403);
    assert.equal((await on.json()).error.code, 'FRESH_CODE_REQUIRED');
    assert.equal((await ops.withdrawalsSwitchState(database.db)).paused, true);
    const frozen = await call(
      stack.api,
      'POST',
      `/v1/ops/pages/${id}/withdrawal-freeze`,
      first.cookie,
      {
        reason: REASON,
      },
    );
    assert.equal(frozen.status, 200);
    const read = await call(
      stack.api,
      'GET',
      `/v1/ops/pages/${id}/withdrawal-freeze`,
      first.cookie,
    );
    assert.equal(read.status, 200);
    const { issueId } = (await read.json()).data;
    assert.ok(issueId);
    const { user_id: userId } = await profile('ada');
    await q(
      `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day')`,
      [userId, randomUUID()],
    );
    const ended = await call(
      stack.api,
      'POST',
      `/v1/ops/accounts/${userId}/end-sessions`,
      first.cookie,
      {
        reason: REASON,
      },
    );
    assert.equal(ended.status, 200, await ended.clone().text());
    assert.equal(
      (
        await q(
          `SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        )
      ).length,
      0,
    );
    const release = await call(
      stack.api,
      'POST',
      `/v1/ops/issues/${issueId}/resolve`,
      first.cookie,
      {
        reason: REASON,
        outcome: 'account_secured',
        bankAndSignInChecked: true,
      },
    );
    assert.equal(release.status, 403);
    assert.equal((await release.json()).error.code, 'FRESH_CODE_REQUIRED');
  } finally {
    await q(`UPDATE ops_sessions SET last_totp_at = now()`);
    assert.equal((await set(false)).status, 200);
  }
});

test('M4, M6: asking is limited per person, not per address, and routine closes don’t count', async () => {
  const a = await opsSignIn(limited.api, database.db, '+2348037770003');
  const b = await opsSignIn(limited.api, database.db, '+2348037770004');
  const { id } = await profile();
  for (let i = 0; i < 5; i += 1) {
    const routine = await ops.openIssue(database.db, {
      dedupeKey: `stuck_tip.${randomUUID()}`,
      kind: 'pending_recovery',
      subject: { profileId: id },
      now: new Date(),
    });
    const closed = await call(
      limited.api,
      'POST',
      `/v1/ops/issues/${routine.id}/resolve`,
      a.cookie,
      {
        reason: REASON,
      },
    );
    assert.equal(closed.status, 200, await closed.clone().text());
  }
  const ask = (person) =>
    call(limited.api, 'POST', `/v1/ops/pages/${id}/fee`, person.cookie, {
      feeBps: 77,
      reason: REASON,
    });
  for (let i = 0; i < 3; i += 1) assert.equal((await ask(a)).status, 202);
  assert.equal((await ask(a)).status, 429);
  assert.equal((await ask(b)).status, 202, 'another person, same address');
});

test('N5: money closes count against the limit, per person', async () => {
  const c = await opsSignIn(limited.api, database.db, '+2348037770005');
  const closeOne = async () =>
    call(
      limited.api,
      'POST',
      `/v1/ops/issues/${await moneyIssue()}/resolve`,
      c.cookie,
      { reason: REASON, outcome: 'recipient_owes' },
    );
  for (let i = 0; i < 3; i += 1) assert.equal((await closeOne()).status, 202);
  assert.equal((await closeOne()).status, 429);
});

test('N5: the document says money closes are limited', async () => {
  const document = JSON.parse(
    readFileSync(
      new URL('../../docs/api/openapi.json', import.meta.url),
      'utf8',
    ),
  );
  const route = document.paths['/v1/ops/issues/{id}/resolve'].post;
  assert.match(route['x-tipme-rate-limit'], /ops_request/);
});

test('M5: signing in finds its own code while mail is landing in the inbox', async () => {
  let writing = true;
  const writer = (async () => {
    while (writing) {
      await q(
        `INSERT INTO pretend_outbox (id, channel, recipient_hint, subject, body)
         VALUES (gen_random_uuid(), 'email', 'x', 'Mail', 'Your other number is 000000')`,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  try {
    for (let i = 0; i < 5; i += 1) await signIn(stack.api, `+234803777020${i}`);
  } finally {
    writing = false;
    await writer;
  }
});
