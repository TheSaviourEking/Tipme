import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { postLedgerTransaction } from '../../packages/database/dist/operations/ledger.js';
import { buildCollectTransferPosting } from '../../packages/domain/dist/index.js';
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
  const [share] = await q(
    `UPDATE collect_transfers SET status = 'paid', paid_at = now(), sent_at = now(),
            account_reference = 'acct_collectrf' WHERE tip_id = $1 AND kind = 'share'
      RETURNING id, amount_minor`,
    [intent.tipId],
  );
  // The share's move, booked as the transfer machine books it: the money left TipMe's balance.
  await database.db.transaction((tx) =>
    postLedgerTransaction(tx, {
      operationType: 'collect_transfer',
      operationKey: `collect_transfer.${share.id}`,
      currency: 'NGN',
      tipId: intent.tipId,
      traceId: null,
      lines: buildCollectTransferPosting({
        amountMinor: BigInt(share.amount_minor),
        profileId,
      }),
    }),
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

/* Fix round 3 (re-review 2, N4): a person's remainder after a partial lost dispute, over HTTP. */

test('N4: after a partial lost dispute, staff can return the person’s remainder over the API, once', async () => {
  const { db } = database;
  const [{ id: userId }] = await q(
    `INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id`,
  );
  const handle = `collectn4_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const [{ id: profileId }] = await q(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, collection_mode,
       collect_verified_at)
     VALUES (gen_random_uuid(), $1, $2, $2, 'Page', 'live', 'collect', now()) RETURNING id`,
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
  const chargeReference = `ch_${randomUUID().slice(0, 8)}`;
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
          chargeReference,
        };
      },
    },
    now: new Date(),
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(settled.applied, 1);
  const tipId = intent.tipId;
  // The share moved to their account, booked as the transfer machine books it.
  const [share] = await q(
    `UPDATE collect_transfers SET status = 'paid', paid_at = now(), sent_at = now(),
            account_reference = 'acct_collectn4' WHERE tip_id = $1 AND kind = 'share'
      RETURNING id, amount_minor`,
    [tipId],
  );
  await db.transaction((tx) =>
    postLedgerTransaction(tx, {
      operationType: 'collect_transfer',
      operationKey: `collect_transfer.${share.id}`,
      currency: 'NGN',
      tipId,
      traceId: null,
      lines: buildCollectTransferPosting({
        amountMinor: BigInt(share.amount_minor),
        profileId,
      }),
    }),
  );
  // A refund asked (one owner: it runs alone), its take-back paid, then refused by the partner.
  const asked = await call(stack.api, 'POST', `/v1/ops/tips/${tipId}/refund`, {
    reason: REASON,
  });
  assert.equal(asked.status, 200, await asked.clone().text());
  const listed = [];
  const transfers = {
    name: 'bachs-sandbox',
    async collectBack(input) {
      const t = {
        transferRef: `tr_${listed.length + 1}`,
        status: 'paid',
        amountMinor: input.amountMinor,
        currency: input.currency,
        group: input.idempotencyKey,
      };
      listed.push(t);
      return { transferRef: t.transferRef, status: 'paid' };
    },
    async sendCollectTransfer(input) {
      return this.collectBack(input);
    },
    async listAccountTransfers() {
      return listed;
    },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
  };
  let refuse = false;
  const refunder = {
    async refundAccountCharge() {
      throw new Error('never as the recipient');
    },
    async refundPlatformCharge() {
      if (refuse) {
        const error = new Error('Insufficient balance to refund');
        error.name = 'ProRefundRefusedError';
        error.providerCode = 'INSUFFICIENT_BALANCE';
        throw error;
      }
      return { refundReference: 'rf_n4', status: 'processing' };
    },
    async verifyTransaction() {
      return { method: 'NGN_CARD', chargeReference };
    },
  };
  const sendRefunds = () =>
    ops.sendTipRefunds(db, {
      provider: refunder,
      providerName: 'bachs',
      now: new Date(),
    });
  await sendRefunds();
  await ops.runCollectTransfers(db, { provider: transfers, now: new Date() });
  refuse = true;
  await sendRefunds();
  const [failed] = await q(`SELECT status FROM tip_refunds WHERE tip_id = $1`, [
    tipId,
  ]);
  assert.equal(failed.status, 'FAILED');
  // A dispute for half the share, lost: the loss uses half of what came back.
  const dispute = (status, at) =>
    ops.applyDisputeEvent(db, {
      event: {
        kind: 'dispute',
        eventId: `evt_${randomUUID()}`,
        eventType: status === 'open' ? 'dispute.created' : 'dispute.updated',
        scope: 'platform',
        partnerDisputeId: `dp_${tipId.slice(0, 8)}`,
        chargeReference,
        providerReference: null,
        operationReference: null,
        status,
        amountMinor: 475_000n,
        currency: 'NGN',
        reason: 'fraudulent',
        respondBy: new Date(Date.now() + 7 * 86_400_000),
        feeMinor: null,
        feeCurrency: null,
        occurredAt: at,
      },
      provider: 'bachs',
      now: at,
    });
  await dispute('open', new Date());
  await dispute('lost', new Date(Date.now() + 3_600_000));
  await ops.runDisputeSteps(db, { now: new Date(Date.now() + 2 * 3_600_000) });
  // Staff read the remainder, and can return it.
  const read = await call(stack.api, 'GET', `/v1/ops/tips/${tipId}/refund`);
  assert.equal(read.status, 200);
  const readBody = (await read.json()).data;
  assert.equal(readBody.heldMinor, '475000');
  // Task 15 follow-up: what was pulled back from a business is reported beside it (none here).
  assert.equal(readBody.businessHeldMinor, '0');
  const back = await call(
    stack.api,
    'POST',
    `/v1/ops/tips/${tipId}/refund/return`,
    {
      reason: 'The refund failed and the dispute was settled: return the rest.',
    },
  );
  assert.equal(back.status, 200, await back.clone().text());
  assert.equal((await back.json()).data.amountMinor, '475000');
  assert.deepEqual(
    await q(
      `SELECT amount_minor::text AS amount FROM collect_transfers WHERE tip_id = $1 AND kind = 'return'`,
      [tipId],
    ),
    [{ amount: '475000' }],
  );
  // Asked again while it is on its way: refused, nothing more made.
  const twice = await call(
    stack.api,
    'POST',
    `/v1/ops/tips/${tipId}/refund/return`,
    {
      reason: 'The refund failed and the dispute was settled: return the rest.',
    },
  );
  assert.equal(twice.status, 409);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM collect_transfers WHERE tip_id = $1 AND kind = 'return'`,
        [tipId],
      )
    ).length,
    1,
  );
});
