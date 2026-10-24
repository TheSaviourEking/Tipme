import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  issueById,
  listIssues,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let owner;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348039990001');
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
const q = (sql, params) =>
  database.pool.query(sql, params).then((result) => result.rows);
const audit = async () =>
  json(await call('GET', '/v1/ops/audit', owner.cookie));

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out');
}

/** Quote + intent for a tip to `handle`; `pay(outcome)` finishes it at the mock checkout. */
async function startTip(handle) {
  const quote = await fetch(`${stack.api}/v1/tip-quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, amountMinor: '200000', currency: 'NGN' }),
  });
  if (quote.status !== 200 && quote.status !== 201)
    return {
      quoteStatus: quote.status,
      quoteError: (await quote.json()).error,
    };
  const intent = await (
    await fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ quoteId: (await quote.json()).data.quoteId }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  return {
    tipId: intent.data.tipId,
    pay: (outcome) =>
      fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome }),
      }),
  };
}

const ownerId = async () =>
  (await q(`SELECT id FROM users WHERE phone_e164 = '+2348039990001'`))[0].id;

test('resolving needs a reason; it records who resolved it and why', async () => {
  const tip = await startTip('tobi');
  await tip.pay('wrong-amount');
  const issue = await waitFor(async () =>
    (
      await listIssues(database.db, { kind: 'payment_mismatch', limit: 50 })
    ).find((i) => i.subject.tipId === tip.tipId),
  );
  const path = `/v1/ops/issues/${issue.id}/resolve`;
  assert.equal((await call('POST', path, owner.cookie, {})).status, 400);
  const reason = 'Provider confirmed the amount by phone; nothing to book';
  assert.equal(
    (await call('POST', path, owner.cookie, { reason })).status,
    200,
  );
  const resolved = await issueById(database.db, issue.id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedBy, await ownerId());
  const again = await call('POST', path, owner.cookie, { reason });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'ISSUE_RESOLVED');
  const row = (await audit()).find(
    (e) => e.action === 'issue.resolved' && e.subjectId === issue.id,
  );
  assert.equal(row.reason, reason);
  assert.equal(row.permission, 'issues.resolve');

  const note = await call(
    'POST',
    `/v1/ops/issues/${issue.id}/notes`,
    owner.cookie,
    {
      text: 'Called the provider at 10:05.',
    },
  );
  assert.equal(note.status, 201);
  const evidence = await json(
    await call('GET', `/v1/ops/issues/${issue.id}`, owner.cookie),
  );
  assert.deepEqual(
    evidence.notes.map((n) => n.text),
    ['Called the provider at 10:05.'],
  );
});

test('a suspended page: hidden, no new tips, cannot go live, in-flight tips settle without moments, withdrawals work (Review Focus 5)', async () => {
  const recipient = await signIn(stack.api, '+2348039990002');
  const handle = `susp${randomUUID().slice(0, 6)}`;
  assert.equal(
    (await call('POST', '/v1/me/page', recipient.cookie, { handle })).status,
    201,
  );
  assert.equal(
    (
      await call('PUT', '/v1/me/page/state', recipient.cookie, {
        state: 'live',
      })
    ).status,
    200,
  );
  const inFlight = await startTip(handle);
  assert.ok(inFlight.tipId);
  const [{ id: profileId }] = await q(
    'SELECT id FROM profiles WHERE handle_lower = $1',
    [handle],
  );

  const reason = 'Reported for impersonating a well-known chef';
  assert.equal(
    (await call('POST', `/v1/ops/pages/${profileId}/suspend`, owner.cookie, {}))
      .status,
    400,
  );
  assert.equal(
    (
      await call('POST', `/v1/ops/pages/${profileId}/suspend`, owner.cookie, {
        reason,
      })
    ).status,
    200,
  );
  assert.equal((await fetch(`${stack.api}/v1/profiles/${handle}`)).status, 404);
  const blocked = await startTip(handle);
  assert.equal(blocked.quoteStatus, 404);
  assert.equal(blocked.quoteError.code, 'PROFILE_NOT_FOUND');
  const live = await call('PUT', '/v1/me/page/state', recipient.cookie, {
    state: 'live',
  });
  assert.equal(live.status, 409);
  assert.equal((await live.json()).error.code, 'PAGE_SUSPENDED');
  assert.equal(
    (
      await call('PUT', '/v1/me/page/state', recipient.cookie, {
        state: 'not_live',
      })
    ).status,
    200,
    'going not live is still allowed',
  );
  const mine = await json(
    await call('GET', '/v1/me/profile', recipient.cookie),
  );
  assert.equal(mine.suspended, true);
  assert.equal(mine.suspendedReason, reason);

  // The tip started before the suspension still settles; it earns no moment.
  await inFlight.pay('succeed');
  await waitFor(async () => {
    const list = await json(
      await call('GET', '/v1/me/notifications', recipient.cookie),
    );
    return list.some((n) => n.tipId === inFlight.tipId);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    (
      await q('SELECT count(*)::int AS n FROM moments WHERE profile_id = $1', [
        profileId,
      ])
    )[0].n,
    0,
  );
  const withdrawal = await call(
    'POST',
    '/v1/me/withdrawals',
    recipient.cookie,
    { amountMinor: '100000' },
    { 'idempotency-key': randomUUID() },
  );
  assert.ok([200, 201].includes(withdrawal.status), `${withdrawal.status}`);

  const actions = (await audit()).filter((e) => e.subjectId === profileId);
  assert.ok(
    actions.some((e) => e.action === 'page.suspended' && e.reason === reason),
  );

  assert.equal(
    (
      await call('POST', `/v1/ops/pages/${profileId}/unsuspend`, owner.cookie, {
        reason: 'Identity confirmed with the recipient',
      })
    ).status,
    200,
  );
  const restored = await json(
    await call('GET', '/v1/me/profile', recipient.cookie),
  );
  assert.equal(restored.suspended, false);
  assert.equal(restored.suspendedReason, null);
  assert.equal(
    (
      await call('PUT', '/v1/me/page/state', recipient.cookie, {
        state: 'live',
      })
    ).status,
    200,
  );
});

test('re-check asks the provider once: a payment that never got a reply settles, with no new charge', async () => {
  const tip = await startTip('tobi');
  await tip.pay('no-reply');
  const [attempt] = await q(
    `SELECT a.id, a.status FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id WHERE t.id = $1`,
    [tip.tipId],
  );
  assert.equal(
    (await q('SELECT status FROM tips WHERE id = $1', [tip.tipId]))[0].status,
    'AWAITING_PAYMENT',
  );
  const response = await call('POST', '/v1/ops/recheck', owner.cookie, {
    attemptId: attempt.id,
    reason: 'Supporter says the money left their account',
  });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).outcome, 'applied');
  assert.equal(
    (await q('SELECT status FROM tips WHERE id = $1', [tip.tipId]))[0].status,
    'SUCCEEDED',
  );
  assert.equal(
    (
      await q(
        `SELECT count(*)::int AS n FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id WHERE t.id = $1`,
        [tip.tipId],
      )
    )[0].n,
    1,
  );
  assert.ok(
    (await audit()).some(
      (e) => e.action === 'payment.rechecked' && e.subjectId === attempt.id,
    ),
  );
  assert.equal(
    (
      await call('POST', '/v1/ops/recheck', owner.cookie, {
        reason: 'Nothing named here at all',
      })
    ).status,
    400,
  );
});

test('a pending phone recovery can be cancelled by staff, with a reason', async () => {
  const recipient = await signIn(stack.api, '+2348039990003');
  const [{ id: userId }] = await q(
    `SELECT id FROM users WHERE phone_e164 = '+2348039990003'`,
  );
  await q(
    `INSERT INTO phone_recoveries (id, user_id, new_phone_e164, effective_at)
     VALUES (gen_random_uuid(), $1, '+2348039990004', now() + interval '24 hours')`,
    [userId],
  );
  const response = await call(
    'POST',
    `/v1/ops/users/${userId}/cancel-recovery`,
    owner.cookie,
    { reason: 'Owner called support: they did not ask for this' },
  );
  assert.equal(response.status, 200);
  assert.equal((await json(response)).cancelled, 1);
  const pending = await json(
    await call('GET', '/v1/me/recovery', recipient.cookie),
  );
  assert.equal(pending.length, 0);
  assert.ok(
    (await audit()).some(
      (e) => e.action === 'recovery.cancelled' && e.subjectId === userId,
    ),
  );
});
