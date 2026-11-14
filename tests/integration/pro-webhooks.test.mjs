import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  buyProByCheckout,
  mailSealing,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  ADA,
  atLaunchProPrice,
} from '../../packages/database/test/integration/helpers.mjs';

// Paid Pro, plan Task 5/6 (ADR-0015): an event from TipMe's own account (scope platform) goes to Pro
// billing and nowhere else; the read-back decides. Events are shaped as the adapter normalises
// them from the sandbox evidence (no top-level `account`).
const sealing = mailSealing(Buffer.alloc(32, 9));

async function openPurchase(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  // How a Pro payment is confirmed, at the ₦2,500 these figures were written for.
  await atLaunchProPrice(database);
  await seedDemoProfiles(database.db);
  const { db } = database;
  const fake = {
    async initializePlatformCheckout(input) {
      return {
        providerReference: `platform:cs_${input.purchaseId}`,
        checkoutUrl: 'https://checkout.bachs.io/session/x',
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    },
  };
  const bought = await buyProByCheckout(db, {
    profileId: ADA,
    expectedAmountMinor: 250000n,
    idempotencyKey: randomUUID(),
    provider: fake,
    providerName: 'bachs',
    successUrl: 'https://usetipme.xyz/dashboard/settings#plan',
    cancelUrl: 'https://usetipme.xyz/dashboard/settings#plan',
    now: new Date(),
  });
  const reference = `platform:cs_${bought.purchaseId}`;
  const q = (text, values = []) =>
    database.pool.query(text, values).then((result) => result.rows);
  const service = new WebhookService({ db }, sealing, { warn() {} });
  return { db, q, service, purchaseId: bought.purchaseId, reference };
}

const collection = (reference, purchaseId, over = {}) => ({
  kind: 'payment',
  eventId: `evt_${randomUUID()}`,
  eventType: 'collection.succeeded',
  scope: 'platform',
  providerReference: reference,
  operationReference: purchaseId,
  accountReference: null,
  status: 'pending',
  amountMinor: 250000n,
  currency: 'NGN',
  feeMinor: 5000n,
  feePaidBy: 'unknown',
  ...over,
});
const reads = (status, over = {}) => ({
  environment: 'sandbox',
  calls: [],
  async verifyTransaction(reference) {
    this.calls.push(reference);
    return {
      status,
      amountMinor: 250000n,
      currency: 'NGN',
      feeMinor: 5000n,
      feePaidBy: 'platform',
      method: 'NGN_CARD',
      ...over,
    };
  },
});

test('a platform event matches its purchase, never a tip attempt, and the read-back confirms it', async (t) => {
  const { q, service, purchaseId, reference } = await openPurchase(t);
  const bachs = reads('succeeded');
  const outcome = await service.applyBachs(
    collection(reference, purchaseId),
    bachs,
  );
  assert.equal(outcome, 'pro_paid');
  assert.deepEqual(bachs.calls, [reference]);
  const [purchase] = await q(`SELECT status FROM pro_purchases`);
  assert.equal(purchase.status, 'PAID');
  const [event] = await q(
    `SELECT pro_purchase_id, attempt_id FROM provider_events`,
  );
  assert.equal(event.pro_purchase_id, purchaseId);
  assert.equal(event.attempt_id, null);
  assert.equal((await q(`SELECT 1 FROM tips`)).length, 0);
  assert.equal(
    (await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan,
    'pro',
  );
});

test('the webhook alone grants nothing: a read-back that is still pending changes nothing', async (t) => {
  const { q, service, purchaseId, reference } = await openPurchase(t);
  const outcome = await service.applyBachs(
    collection(reference, purchaseId),
    reads('pending'),
  );
  assert.equal(outcome, 'pro_pending');
  assert.equal(
    (await q(`SELECT status FROM pro_purchases`))[0].status,
    'PENDING',
  );
  assert.equal(
    (await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan,
    'free',
  );
});

test('the same event twice, and checkout.completed after it, book once', async (t) => {
  const { q, service, purchaseId, reference } = await openPurchase(t);
  const event = collection(reference, purchaseId);
  await service.applyBachs(event, reads('succeeded'));
  await service.applyBachs(event, reads('succeeded'));
  await service.applyBachs(
    collection(reference, purchaseId, { eventType: 'checkout.completed' }),
    reads('succeeded'),
  );
  assert.equal((await q(`SELECT 1 FROM ledger_transactions`)).length, 1);
  assert.equal((await q(`SELECT 1 FROM pro_periods`)).length, 1);
});

test('a platform event with no purchase is unmatched', async (t) => {
  const { q, service } = await openPurchase(t);
  const outcome = await service.applyBachs(
    collection('platform:cs_unknown', randomUUID()),
    reads('succeeded'),
  );
  assert.equal(outcome, 'unmatched');
  assert.equal((await q(`SELECT 1 FROM unmatched_provider_events`)).length, 1);
  assert.equal(
    (await q(`SELECT status FROM pro_purchases`))[0].status,
    'PENDING',
  );
});

test('failed after succeeded keeps PAID and raises pro.conflict', async (t) => {
  const { q, service, purchaseId, reference } = await openPurchase(t);
  await service.applyBachs(
    collection(reference, purchaseId),
    reads('succeeded'),
  );
  const outcome = await service.applyBachs(
    collection(reference, purchaseId, {
      eventType: 'collection.failed',
      status: 'failed',
    }),
    reads('failed'),
  );
  assert.equal(outcome, 'pro_already');
  assert.equal((await q(`SELECT status FROM pro_purchases`))[0].status, 'PAID');
  assert.equal(
    (await q(`SELECT 1 FROM outbox_events WHERE event_type = 'pro.conflict'`))
      .length,
    1,
  );
});

test('a platform refund.paid on a Pro charge ends Pro and opens a money issue', async (t) => {
  const { q, service, purchaseId, reference } = await openPurchase(t);
  await service.applyBachs(
    collection(reference, purchaseId),
    reads('succeeded'),
  );
  const outcome = await service.applyBachs(
    {
      kind: 'reversal',
      eventId: `evt_${randomUUID()}`,
      eventType: 'refund.paid',
      scope: 'platform',
      accountReference: null,
      providerReference: reference,
      operationReference: purchaseId,
      partnerReversalId: 'refund.rf_1',
      disputeWon: false,
      refundState: 'paid',
      refundedMinor: 250000n,
      refundFeeMinor: null,
    },
    reads('succeeded'),
  );
  // Plan Task 9: refund.paid books the reversal (Pro revenue back) and ends that month.
  assert.equal(outcome, 'pro_refund_refunded');
  assert.equal(
    (await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan,
    'free',
  );
  assert.equal((await q(`SELECT status FROM pro_periods`))[0].status, 'ENDED');
  assert.equal(
    (await q(`SELECT 1 FROM outbox_events WHERE event_type = 'pro.reversed'`))
      .length,
    1,
  );
  // Not unmatched any more; the sale and its refund, and no recipient's balance changed.
  assert.equal((await q(`SELECT 1 FROM unmatched_provider_events`)).length, 0);
  assert.deepEqual(
    (
      await q(
        `SELECT operation_type FROM ledger_transactions ORDER BY operation_type::text`,
      )
    ).map((r) => r.operation_type),
    ['pro_refund', 'pro_sale'],
  );
});

test('a refund that is only created flags it and keeps Pro', async (t) => {
  const { q, service, purchaseId, reference } = await openPurchase(t);
  await service.applyBachs(
    collection(reference, purchaseId),
    reads('succeeded'),
  );
  await service.applyBachs(
    {
      kind: 'reversal',
      eventId: `evt_${randomUUID()}`,
      eventType: 'refund.created',
      scope: 'platform',
      accountReference: null,
      providerReference: reference,
      operationReference: purchaseId,
      partnerReversalId: 'refund.rf_2',
      disputeWon: false,
      refundState: 'pending',
      refundedMinor: null,
      refundFeeMinor: null,
    },
    reads('succeeded'),
  );
  assert.equal(
    (await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan,
    'pro',
  );
  assert.equal(
    (await q(`SELECT 1 FROM outbox_events WHERE event_type = 'pro.reversed'`))
      .length,
    1,
  );
});
