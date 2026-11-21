import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  browserHeaders,
  opsSignIn,
  setSwitch,
  startStack,
} from './helpers.mjs';

/*
 * Staff "Refund tip" over HTTP (owner, 14 Nov 2026), behind the `tip_refunds` admin switch (a money
 * switch, off by default): staff with
 * payments.repair read what the supporter gets back and who gives back what, and ask with a written
 * reason and a fresh code (`tip.refund`; with one owner it runs alone and says so). The pretend
 * partner stands in: nothing here reaches the network.
 */
let database;
let stack;
let owner;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const REASON =
  'The supporter paid twice by mistake and asked us to refund one.';

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  const env = {
    WEB_ORIGIN: WEB,
    RATE_LIMIT_AUTH_PER_HOUR: '1000',
    RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
  };
  stack = await startStack({ databaseUrl: database.url, apiEnv: env });
  await setSwitch(database.pool, 'tip_refunds', true);
  owner = await opsSignIn(stack.api, database.db, '+2348037770101');
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

async function paidTip() {
  const { db } = database;
  const quote = await ops.createQuote(db, {
    handle: 'tobi',
    tipMinor: 1_000_000n,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `mock_pay_${randomUUID()}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await ops.recordProviderEvent(db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 1_000_000n,
    currency: 'NGN',
    providerFeeMinor: 20000n,
    signatureVerified: true,
    payload: {},
  });
  return { tipId: intent.tipId, reference };
}

const call = (base, method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: browserHeaders(owner.cookie),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test('with the tip_refunds switch off, the routes answer 404', async () => {
  const { tipId } = await paidTip();
  await setSwitch(database.pool, 'tip_refunds', false);
  try {
    const read = await call(stack.api, 'GET', `/v1/ops/tips/${tipId}/refund`);
    assert.equal(read.status, 404);
    assert.equal((await read.json()).error.code, 'TIP_REFUNDS_OFF');
    const asked = await call(
      stack.api,
      'POST',
      `/v1/ops/tips/${tipId}/refund`,
      { reason: REASON },
    );
    assert.equal(asked.status, 404);
  } finally {
    await setSwitch(database.pool, 'tip_refunds', true);
  }
});

test('staff read the figures, ask once with a reason, and a second ask is refused in plain words', async () => {
  const { tipId } = await paidTip();
  const read = await call(stack.api, 'GET', `/v1/ops/tips/${tipId}/refund`);
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual((await read.json()).data, {
    tipId,
    refundable: true,
    refusal: null,
    words: 'This tip can be refunded. TipMe keeps its fee.',
    handle: 'tobi',
    businessName: null,
    currency: 'NGN',
    grossMinor: '1000000',
    feeMinor: '50000',
    refundMinor: '950000',
    personMinor: '950000',
    businessMinor: '0',
    refund: null,
  });
  const short = await call(stack.api, 'POST', `/v1/ops/tips/${tipId}/refund`, {
    reason: 'short',
  });
  assert.equal(short.status, 400);
  const asked = await call(stack.api, 'POST', `/v1/ops/tips/${tipId}/refund`, {
    reason: REASON,
  });
  assert.equal(asked.status, 200, await asked.clone().text());
  const { data } = await asked.json();
  assert.equal(data.amountMinor, '950000');
  assert.equal(data.actedAlone, true);
  const [row] = await q(
    `SELECT status, amount_minor FROM tip_refunds WHERE tip_id = $1`,
    [tipId],
  );
  assert.deepEqual(row, { status: 'REQUESTED', amount_minor: '950000' });
  const again = await call(stack.api, 'GET', `/v1/ops/tips/${tipId}/refund`);
  const facts = (await again.json()).data;
  assert.equal(facts.refusal, 'already');
  assert.deepEqual(facts.refund, { status: 'REQUESTED' });
  const twice = await call(stack.api, 'POST', `/v1/ops/tips/${tipId}/refund`, {
    reason: REASON,
  });
  assert.equal(twice.status, 409);
  assert.equal((await twice.json()).error.code, 'TIP_REFUND_REFUSED');
});

test('a tip the partner says was paid by bank transfer is refused up front, before anyone asks', async () => {
  const { tipId, reference } = await paidTip();
  const redis = new Redis(REDIS_URL);
  await redis.set(
    `mockprovider:${stack.prefix}:method:${reference}`,
    'bank_transfer',
  );
  await redis.quit();
  const read = await call(stack.api, 'GET', `/v1/ops/tips/${tipId}/refund`);
  const facts = (await read.json()).data;
  assert.equal(facts.refundable, false);
  assert.equal(facts.refusal, 'bank_transfer');
  assert.match(facts.words, /bank transfer, so it can’t be refunded/);
  const asked = await call(stack.api, 'POST', `/v1/ops/tips/${tipId}/refund`, {
    reason: REASON,
  });
  assert.equal(asked.status, 409);
  assert.equal(
    (await q(`SELECT 1 FROM tip_refunds WHERE tip_id = $1`, [tipId])).length,
    0,
  );
});

/** A collect tip (plan Task 10) to a new page, whose share moved; they withdrew `withdrawnMinor`. */
async function collectTip(withdrawnMinor) {
  const { db } = database;
  const [{ id: userId }] = await q(
    `INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id`,
  );
  const handle = `collectrf_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const [{ id: profileId }] = await q(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, collection_mode)
     VALUES (gen_random_uuid(), $1, $2, $2, 'Page', 'live', 'collect') RETURNING id`,
    [userId, handle],
  );
  const quote = await ops.createQuote(db, {
    handle,
    tipMinor: 1_000_000n,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
  });
  await q(
    `UPDATE payment_attempts SET created_at = now() - interval '1 minute' WHERE id = $1`,
    [intent.attemptId],
  );
  const settled = await ops.reconcileAttempts({
    db,
    provider: {
      environment: 'sandbox',
      async verifyTransaction() {
        return {
          status: 'succeeded',
          amountMinor: 1_000_000n,
          currency: 'NGN',
          feeMinor: 20_000n,
          feePaidBy: 'platform',
          method: 'NGN_CARD',
          chargeReference: `ch_${randomUUID().slice(0, 8)}`,
        };
      },
    },
    now: new Date(),
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(settled.applied, 1);
  await q(
    `UPDATE collect_transfers SET status = 'paid', paid_at = now(), sent_at = now(),
            account_reference = 'acct_collectrf' WHERE tip_id = $1 AND kind = 'share'`,
    [intent.tipId],
  );
  if (withdrawnMinor > 0n)
    await q(
      `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
       VALUES (gen_random_uuid(), $1, 'NGN', $2, 'REQUESTED', $3, 'test')`,
      [profileId, withdrawnMinor, randomUUID()],
    );
  return intent.tipId;
}

test('a collect tip whose share was withdrawn shows the gap; only the second-person step goes ahead', async () => {
  const tipId = await collectTip(650_000n);
  const read = await call(stack.api, 'GET', `/v1/ops/tips/${tipId}/refund`);
  assert.equal(read.status, 200, await read.clone().text());
  const facts = (await read.json()).data;
  assert.equal(facts.refundable, true);
  assert.equal(facts.refundMinor, '950000');
  assert.deepEqual(facts.collect, {
    plan: 'staff_decides',
    gapMinor: '650000',
  });
  assert.equal(facts.lastFailure, null);
  // The plain refund would have TipMe absorb money nobody decided to.
  const plain = await call(stack.api, 'POST', `/v1/ops/tips/${tipId}/refund`, {
    reason: REASON,
  });
  assert.equal(plain.status, 409);
  assert.equal((await plain.json()).error.code, 'TIP_REFUND_NEEDS_DECISION');
  const absorb = await call(
    stack.api,
    'POST',
    `/v1/ops/tips/${tipId}/refund/absorb-gap`,
    { reason: REASON },
  );
  assert.equal(absorb.status, 200, await absorb.clone().text());
  // One owner: it runs alone and says so (the alert goes to the others).
  assert.equal((await absorb.json()).data.actedAlone, true);
  const [row] = await q(
    `SELECT collect_plan, gap_minor::text AS gap FROM tip_refunds WHERE tip_id = $1`,
    [tipId],
  );
  assert.deepEqual(row, { collect_plan: 'absorb', gap: '650000' });
  // A tip with nothing to absorb never goes through the absorb step.
  const whole = await collectTip(0n);
  const none = await call(
    stack.api,
    'POST',
    `/v1/ops/tips/${whole}/refund/absorb-gap`,
    { reason: REASON },
  );
  assert.equal(none.status, 409);
});
