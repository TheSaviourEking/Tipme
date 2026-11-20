import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { BachsWebhookController } from '../../apps/api/dist/webhooks/bachs-webhook.controller.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import { createBachsProvider } from '../../packages/payments/dist/index.js';
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

/*
 * You collect, plan Task 5 (controller ruling P5): TipMe's own dispute.created and dispute.updated
 * now normalise to `kind: 'dispute'`. Until Task 9 routes those, Pro billing must see exactly what it
 * saw before. Events go through the real adapter from bodies shaped as the partner's dispute docs
 * (https://docs.bachs.io/guides/webhooks/events/dispute-created and dispute-updated).
 */
const PLATFORM_ORG = 'acct_stWbI4933A4WVqkc';
const BACHS_SECRET = 'current-secret-0123456789';
const adapter = createBachsProvider({
  apiKey: 'sk_sandbox_test',
  environment: 'sandbox',
  webhookSecrets: [BACHS_SECRET],
  platformOrganizationId: PLATFORM_ORG,
  fetchImpl: async () => {
    throw new Error('no request expected');
  },
});
function delivered(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', BACHS_SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  const result = adapter.verifyWebhook(rawBody, {
    'x-bachs-signature-v2': `t=${timestamp},v1=${signature}`,
  });
  assert.equal(result.ok, true);
  return result.event;
}
const ownDispute = (purchaseId, type, status) => ({
  id: `evt_${type.replace('.', '_')}_${status}`,
  type,
  created_at: new Date().toISOString(),
  organization_id: PLATFORM_ORG,
  data: {
    dispute_id: 'dsp_1a2b3c4d5e',
    charge_id: 'ch_9f4c1d2e7b6a',
    // Not in the dispute docs; today's reversal reads it, so a Pro dispute can name its checkout.
    checkout_id: `cs_${purchaseId}`,
    amount: '2500.00',
    currency: 'NGN',
    status,
    is_response_editable: status === 'needs_response',
    reason: 'fraudulent',
    response_deadline_at: '2026-12-02T00:00:00Z',
  },
});

/** Everything Pro billing leaves behind for one event, after a paid purchase. */
async function proStateAfter(t, makeEvent) {
  const { q, service, purchaseId, reference } = await openPurchase(t);
  await service.applyBachs(
    collection(reference, purchaseId),
    reads('succeeded'),
  );
  const outcome = await service.applyBachs(
    makeEvent(purchaseId, reference),
    reads('succeeded'),
  );
  return {
    outcome,
    plan: (await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan,
    periods: (await q(`SELECT status FROM pro_periods ORDER BY 1`)).map(
      (row) => row.status,
    ),
    outbox: (
      await q(
        `SELECT event_type FROM outbox_events WHERE event_type LIKE 'pro.%' ORDER BY 1`,
      )
    ).map((row) => row.event_type),
    events: await q(
      `SELECT provider_event_id, event_type, payload FROM provider_events
        WHERE pro_purchase_id IS NOT NULL AND event_type LIKE 'dispute%'`,
    ),
    unmatched: (await q(`SELECT 1 FROM unmatched_provider_events`)).length,
  };
}

test('a platform-scoped dispute on a Pro charge still ends Pro exactly as today', async (t) => {
  // A lost dispute the adapter still reads as a reversal (`dispute.lost`, or a chargeback) ends Pro.
  for (const type of ['dispute.lost', 'chargeback.created']) {
    const state = await proStateAfter(t, (purchaseId) => {
      const event = delivered({
        ...ownDispute(purchaseId, 'dispute.created', 'lost'),
        id: `evt_${type}`,
        type,
      });
      assert.equal(event.kind, 'reversal');
      return event;
    });
    assert.equal(state.outcome, 'pro_reversed', type);
    assert.equal(state.plan, 'free', type);
    assert.deepEqual(state.periods, ['ENDED'], type);
  }

  // The documented events are now disputes; Pro billing gets exactly the reversal it got before
  // (recorded from the adapter at 167d7ee9), with the same outcome and the same rows.
  for (const [type, status] of [
    ['dispute.created', 'needs_response'],
    ['dispute.updated', 'lost'],
    ['dispute.updated', 'won'],
  ]) {
    const before = await proStateAfter(t, (purchaseId) => ({
      kind: 'reversal',
      eventId: `evt_${type.replace('.', '_')}_${status}`,
      eventType: type,
      scope: 'platform',
      accountReference: null,
      providerReference: `platform:cs_${purchaseId}`,
      chargeReference: 'ch_9f4c1d2e7b6a',
      operationReference: null,
      partnerReversalId: 'dispute.dsp_1a2b3c4d5e',
      disputeWon: status === 'won',
      refundState: null,
      refundedMinor: null,
      refundFeeMinor: null,
    }));
    const now = await proStateAfter(t, (purchaseId) => {
      const event = delivered(ownDispute(purchaseId, type, status));
      assert.equal(event.kind, 'dispute');
      return event;
    });
    // Purchase ids differ between the two databases; the stored payload names the checkout.
    const strip = (state) => ({
      ...state,
      events: state.events.map((row) => ({
        ...row,
        payload: {
          ...row.payload,
          providerReference: 'platform:cs_<purchase>',
        },
      })),
    });
    assert.deepEqual(strip(now), strip(before), `${type} ${status}`);
    assert.equal(now.events.length, 1);
    assert.equal(now.unmatched, 0);
  }
});

// Review fix 1: the partner reads a 4xx as a refusal and stops delivering, so a signed dispute TipMe
// can't read as one must never be a 400. It is today's reversal, answered 200, and reaches Pro
// billing exactly as before.
test('an unreadable platform dispute still reaches Pro as today’s reversal, with a 2xx', async (t) => {
  for (const [label, change] of [
    ['unknown status', { status: 'pending_magic' }],
    ['no dispute id', { dispute_id: undefined }],
  ]) {
    const { q, service, purchaseId, reference } = await openPurchase(t);
    await service.applyBachs(
      collection(reference, purchaseId),
      reads('succeeded'),
    );
    const body = ownDispute(purchaseId, 'dispute.updated', 'lost');
    body.data = { ...body.data, ...change };
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', BACHS_SECRET)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
      .digest('hex');
    const logs = [];
    const controller = new BachsWebhookController(
      adapter,
      { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry) },
      service,
    );
    // Resolving (not throwing) is the controller's 200.
    const answer = await controller.receive({
      rawBody,
      headers: { 'x-bachs-signature-v2': `t=${timestamp},v1=${signature}` },
    });
    assert.deepEqual(answer, { data: { outcome: 'pro_reversed' } }, label);
    assert.equal(
      logs.some((entry) => entry.event === 'webhook.rejected'),
      false,
      label,
    );
    const [stored] = await q(
      `SELECT payload FROM provider_events WHERE provider_event_id = $1`,
      [body.id],
    );
    assert.equal(stored.payload.kind, 'reversal', label);
    assert.equal(
      stored.payload.partnerReversalId,
      change.dispute_id === undefined && 'dispute_id' in change
        ? null
        : 'dispute.dsp_1a2b3c4d5e',
      label,
    );
    assert.equal(
      (await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan,
      'pro',
      label,
    );
  }
});
