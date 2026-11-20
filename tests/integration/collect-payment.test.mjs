import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  ADA,
  atLaunchProPrice,
} from '../../packages/database/test/integration/helpers.mjs';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { setSwitch, startStack } from './helpers.mjs';

/*
 * You collect (plan Task 7, R2, R3, P6): a collect tip is paid on TipMe's own account, so its events
 * are platform-scoped, like a Pro purchase's. They are matched to the tip first (a tip refund's own
 * reference before anything), and only an event that matches no tip goes to Pro billing. A verified
 * payment books the recipient's net as held money (`held_for_recipients`) and schedules exactly one
 * transfer of it, in the payment's own transaction. The switch is `notBuilt` in production; these
 * tests turn it on by writing its row (R12). A direct tip is booked exactly as before.
 */

const [, TOBI] = ops.DEMO_PROFILES;
const GROSS = 1_000_000n; // ₦10,000 to Tobi, on Free: TipMe keeps 5%.
const NET = 950_000n;
const FEE = 20_000n; // What the partner's read-back says it kept.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sealing = ops.mailSealing(Buffer.alloc(32, 9));

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const service = () =>
  new WebhookService({ db: database.db }, sealing, { warn() {} });

before(async () => {
  database = await openTestDatabase();
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await setSwitch(database.pool, 'you_collect', true);
});

/** A collect tip to `handle`, started on TipMe's own checkout as the checkout service does. */
async function collectTip({ handle = 'tobi', shared } = {}) {
  const { db } = database;
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE handle = $1`, [
    handle,
  ]);
  const quote = await ops.createQuote(db, {
    handle,
    tipMinor: GROSS,
    currency: 'NGN',
    ...(shared ? { businessMemberId: shared.memberId, sharesOn: true } : {}),
  });
  assert.equal(quote.collectionMode, 'collect');
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    ...(shared ? { businessMemberId: shared.memberId, sharesOn: true } : {}),
  });
  const reference = `platform:cs_${randomUUID().slice(0, 8)}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: reference,
  });
  return {
    tipId: intent.tipId,
    attemptId: intent.attemptId,
    reference,
    charge: `ch_${randomUUID().slice(0, 8)}`,
  };
}

/** A collection event on TipMe's own account, as the adapter normalises it. */
const collection = (tip, over = {}) => ({
  kind: 'payment',
  eventId: `evt_${randomUUID()}`,
  eventType: 'collection.succeeded',
  scope: 'platform',
  chargeReference: tip.charge,
  providerReference: tip.reference,
  operationReference: tip.attemptId,
  accountReference: null,
  status: 'pending',
  amountMinor: GROSS,
  currency: 'NGN',
  feeMinor: FEE,
  feePaidBy: 'unknown',
  ...over,
});

/** The partner's read-back of a platform payment (Task 4): TipMe bears the fee, no platform fee. */
const reads = (tip, over = {}) => {
  // A closure, not `this`: the webhook passes the method on detached, as the adapter allows.
  const calls = [];
  return {
    environment: 'sandbox',
    calls,
    async verifyTransaction(reference, expectation) {
      calls.push([reference, expectation]);
      return {
        status: 'succeeded',
        amountMinor: GROSS,
        currency: 'NGN',
        feeMinor: FEE,
        feePaidBy: 'platform',
        method: 'NGN_CARD',
        chargeReference: tip.charge,
        ...over,
      };
    },
  };
};

/** Every ledger line of a tip, owners as roles, in a stable order. */
const linesOf = (tipId) =>
  q(
    `SELECT t.operation_type::text AS type, a.code,
            CASE WHEN a.business_id IS NOT NULL THEN 'business'
                 WHEN a.profile_id IS NOT NULL THEN 'person' ELSE 'tipme' END AS owner,
            e.side::text AS side, e.amount_minor::text AS amount
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.tip_id = $1
      ORDER BY t.operation_type, a.code, owner, e.side`,
    [tipId],
  );
const transactionsOf = (tipId) =>
  q(
    `SELECT operation_type::text AS type, operation_key AS key FROM ledger_transactions
      WHERE tip_id = $1 ORDER BY posted_at`,
    [tipId],
  );
const transfersOf = (tipId) =>
  q(
    `SELECT kind, status, idempotency_key AS key, amount_minor::text AS amount, currency,
            provider, environment::text AS environment, account_reference, charge_reference,
            profile_id, business_id, release_after
       FROM collect_transfers WHERE tip_id = $1`,
    [tipId],
  );
const tipStatusOf = async (tipId) =>
  (await q(`SELECT status FROM tips WHERE id = $1`, [tipId]))[0].status;

/**
 * The held posting of a ₦10,000 Free tip (TipMe's 5%: ₦350 fee and ₦150 quoted processing) with an
 * actual fee of ₦200 (Task 1's builder): TipMe's own line is ₦500 − ₦200 = ₦300, on its own balance.
 */
const line = (code, owner, side, amount) => ({
  type: 'payment',
  code,
  owner,
  side,
  amount: amount.toString(),
});
const HELD_LINES = [
  line('held_for_recipients', 'person', 'debit', NET),
  line('platform_clearing', 'tipme', 'debit', 50_000n - FEE),
  line('platform_fee_revenue', 'tipme', 'credit', 35_000n),
  line('provider_fee_expense', 'tipme', 'debit', FEE),
  line('provider_fee_recovered', 'tipme', 'credit', 15_000n),
  line('recipient_payable', 'person', 'credit', NET),
];

test("a collect tip's verified payment books the held posting and one waiting transfer, once", async () => {
  const tip = await collectTip();
  const bachs = reads(tip);
  const event = collection(tip);
  assert.equal(await service().applyBachs(event, bachs), 'confirmed');
  // Read back on TipMe's own account: no platform fee to expect (Task 4).
  assert.deepEqual(bachs.calls, [[tip.reference, undefined]]);
  assert.equal(await tipStatusOf(tip.tipId), 'SUCCEEDED');
  assert.deepEqual(await transactionsOf(tip.tipId), [
    { type: 'payment', key: `payment.${tip.attemptId}` },
  ]);
  assert.deepEqual(await linesOf(tip.tipId), HELD_LINES);
  const [transfer] = await transfersOf(tip.tipId);
  assert.deepEqual(
    { ...transfer, release_after: undefined },
    {
      kind: 'share',
      status: 'waiting',
      key: `tipme-collect-${tip.tipId}`,
      amount: NET.toString(),
      currency: 'NGN',
      provider: 'bachs',
      environment: 'sandbox',
      // Filled when the row moves to ready, from the account verified then (P8).
      account_reference: null,
      charge_reference: tip.charge,
      profile_id: TOBI.id,
      business_id: null,
      release_after: undefined,
    },
  );
  // Nothing about Pro, and the event is the tip's.
  assert.equal((await q(`SELECT 1 FROM pro_purchases`)).length, 0);
  const stored = await q(
    `SELECT attempt_id, pro_purchase_id FROM provider_events WHERE provider_event_id = $1`,
    [event.eventId],
  );
  assert.deepEqual(stored, [
    { attempt_id: tip.attemptId, pro_purchase_id: null },
  ]);

  // The same webhook again, checkout.completed after it, and the worker's replay: nothing new.
  await service().applyBachs(event, reads(tip));
  await service().applyBachs(
    collection(tip, { eventType: 'checkout.completed' }),
    reads(tip),
  );
  await ops.recordProviderEvent(database.db, {
    provider: 'bachs',
    providerEventId: `reconcile.${tip.attemptId}.succeeded`,
    eventType: 'payment.succeeded',
    attemptId: tip.attemptId,
    providerReference: tip.reference,
    amountMinor: GROSS,
    currency: 'NGN',
    providerFeeMinor: FEE,
    environment: 'sandbox',
    chargeReference: tip.charge,
    signatureVerified: true,
    payload: { source: 'reconciliation' },
  });
  const replay = await ops.reconcileAttempts({
    db: database.db,
    provider: reads(tip),
    now: new Date(),
    minAgeMs: 0,
    attemptId: tip.attemptId,
  });
  assert.equal(replay.applied, 0);
  assert.equal((await transactionsOf(tip.tipId)).length, 1);
  assert.equal((await transfersOf(tip.tipId)).length, 1);

  // Two deliveries at the same moment (different event ids) for a fresh tip: one of each.
  const other = await collectTip();
  const outcomes = await Promise.all([
    service().applyBachs(collection(other), reads(other)),
    service().applyBachs(collection(other), reads(other)),
  ]);
  assert.ok(outcomes.includes('confirmed'), outcomes.join());
  assert.equal((await transactionsOf(other.tipId)).length, 1);
  assert.equal((await transfersOf(other.tipId)).length, 1);
  assert.deepEqual(await linesOf(other.tipId), HELD_LINES);
});

test('with the switch off, a tip quoted collect is still booked as held money', async () => {
  // §12.5: switching off stops new collect sign-ups, never the tips already quoted collect.
  const tip = await collectTip();
  await setSwitch(database.pool, 'you_collect', false);
  assert.equal(
    await service().applyBachs(collection(tip), reads(tip)),
    'confirmed',
  );
  assert.deepEqual(await linesOf(tip.tipId), HELD_LINES);
  assert.equal((await transfersOf(tip.tipId)).length, 1);
});

async function openPurchase() {
  await atLaunchProPrice(database);
  const fake = {
    async initializePlatformCheckout(input) {
      return {
        providerReference: `platform:cs_${input.purchaseId}`,
        checkoutUrl: 'https://checkout.bachs.io/session/x',
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    },
  };
  const bought = await ops.buyProByCheckout(database.db, {
    profileId: ADA,
    expectedAmountMinor: 250000n,
    idempotencyKey: randomUUID(),
    provider: fake,
    providerName: 'bachs',
    successUrl: 'https://usetipme.xyz/dashboard/settings#plan',
    cancelUrl: 'https://usetipme.xyz/dashboard/settings#plan',
    now: new Date(),
  });
  return {
    purchaseId: bought.purchaseId,
    reference: `platform:cs_${bought.purchaseId}`,
    charge: `ch_pro_${randomUUID().slice(0, 8)}`,
  };
}
const proCollection = (pro, over = {}) => ({
  kind: 'payment',
  eventId: `evt_${randomUUID()}`,
  eventType: 'collection.succeeded',
  scope: 'platform',
  chargeReference: pro.charge,
  providerReference: pro.reference,
  operationReference: pro.purchaseId,
  accountReference: null,
  status: 'pending',
  amountMinor: 250000n,
  currency: 'NGN',
  feeMinor: 5000n,
  feePaidBy: 'unknown',
  ...over,
});
const proReads = (pro) => ({
  environment: 'sandbox',
  async verifyTransaction() {
    return {
      status: 'succeeded',
      amountMinor: 250000n,
      currency: 'NGN',
      feeMinor: 5000n,
      feePaidBy: 'platform',
      method: 'NGN_CARD',
      chargeReference: pro.charge,
    };
  },
});
/** A dispute on TipMe's own account, as the adapter models it (Task 5). */
const dispute = (over) => ({
  kind: 'dispute',
  eventId: `evt_${randomUUID()}`,
  eventType: 'dispute.created',
  scope: 'platform',
  partnerDisputeId: `dp_${randomUUID().slice(0, 8)}`,
  chargeReference: null,
  providerReference: null,
  operationReference: null,
  status: 'open',
  amountMinor: GROSS,
  currency: 'NGN',
  reason: 'fraudulent',
  respondBy: null,
  feeMinor: null,
  feeCurrency: null,
  occurredAt: new Date(),
  ...over,
});

test('a platform-scoped event for a collect tip never reaches Pro billing, and a Pro event never reaches a tip', async () => {
  const pro = await openPurchase();
  const tip = await collectTip();
  const purchaseStatus = async () =>
    (await q(`SELECT status FROM pro_purchases`))[0].status;

  // The tip's payment goes down the tip path; Pro is untouched.
  assert.equal(
    await service().applyBachs(collection(tip), reads(tip)),
    'confirmed',
  );
  assert.equal(await purchaseStatus(), 'PENDING');
  // Pro's payment goes to Pro; the tip and its transfer are untouched.
  assert.equal(
    await service().applyBachs(proCollection(pro), proReads(pro)),
    'pro_paid',
  );
  assert.equal(await purchaseStatus(), 'PAID');
  assert.deepEqual(await transactionsOf(tip.tipId), [
    { type: 'payment', key: `payment.${tip.attemptId}` },
  ]);
  assert.equal((await transfersOf(tip.tipId)).length, 1);
  assert.equal(
    (await q(`SELECT 1 FROM provider_events WHERE pro_purchase_id IS NOT NULL`))
      .length,
    1,
  );
  // The tip's events (the webhook and its read-back) are the attempt's, none a purchase's.
  assert.deepEqual(
    await q(
      `SELECT count(*)::int AS events, count(pro_purchase_id)::int AS pro
         FROM provider_events WHERE attempt_id = $1`,
      [tip.attemptId],
    ),
    [{ events: 2, pro: 0 }],
  );

  // A dispute on the tip's charge (Task 9 models it): kept for staff, never Pro, nothing booked.
  const tipDispute = dispute({ chargeReference: tip.charge });
  assert.equal(
    await service().applyBachs(tipDispute, reads(tip)),
    'collect_event_stored',
  );
  assert.deepEqual(
    await q(
      `SELECT reason FROM unmatched_provider_events WHERE provider_event_id = $1`,
      [tipDispute.eventId],
    ),
    [{ reason: 'collect_event' }],
  );
  assert.equal(
    (
      await q(`SELECT 1 FROM provider_events WHERE provider_event_id = $1`, [
        tipDispute.eventId,
      ])
    ).length,
    0,
  );
  assert.equal(await purchaseStatus(), 'PAID');
  // A refund on the tip's checkout that TipMe did not ask for: kept for staff too, never Pro.
  const reversal = {
    kind: 'reversal',
    eventId: `evt_${randomUUID()}`,
    eventType: 'refund.created',
    scope: 'platform',
    accountReference: null,
    providerReference: tip.reference,
    chargeReference: tip.charge,
    operationReference: null,
    partnerReversalId: `refund.re_${randomUUID().slice(0, 8)}`,
    disputeWon: false,
    refundState: 'pending',
    refundedMinor: null,
    refundFeeMinor: null,
  };
  assert.equal(
    await service().applyBachs(reversal, reads(tip)),
    'collect_event_stored',
  );
  assert.equal(await purchaseStatus(), 'PAID');
  assert.equal((await transactionsOf(tip.tipId)).length, 1);

  // A dispute matching no tip still reaches Pro in today's reversal shape (P5): a lost one ends Pro.
  const proDispute = dispute({
    providerReference: pro.reference,
    eventType: 'dispute.updated',
    status: 'lost',
  });
  // Today a lost dispute.updated does not end Pro (Task 5 note): only routing is asserted here.
  assert.equal(
    await service().applyBachs(proDispute, proReads(pro)),
    'pro_reversed',
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM provider_events WHERE provider_event_id = $1 AND pro_purchase_id IS NOT NULL`,
        [proDispute.eventId],
      )
    ).length,
    1,
  );
  assert.equal((await transactionsOf(tip.tipId)).length, 1);

  // TipMe's reference with another checkout than the tip's own is never applied to the tip.
  assert.equal(
    await service().applyBachs(
      collection(tip, { providerReference: 'platform:cs_someone_else' }),
      reads(tip),
    ),
    'unmatched',
  );
  // Anything else on TipMe's own account matches nothing and is kept as unmatched.
  const stray = collection(
    { reference: 'platform:cs_nobody', attemptId: randomUUID(), charge: null },
    {},
  );
  assert.equal(await service().applyBachs(stray, reads(tip)), 'unmatched');
});

test('a tip refund on TipMe’s own account still reaches the tip refund, never Pro or the payment', async () => {
  const tip = await collectTip();
  await service().applyBachs(collection(tip), reads(tip));
  const [{ id: userId }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`refunder.${randomUUID().slice(0, 8)}@example.com`],
  );
  const refundId = randomUUID();
  await q(
    `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider, provider_reference,
       requested_by, approved_by, reason, sent_at)
     VALUES ($1, $2, 'PROCESSING', $3, 'NGN', 'bachs', $4, $5, $5, 'Paid twice by mistake.', now())`,
    [refundId, tip.tipId, NET.toString(), tip.reference, userId],
  );
  const event = {
    kind: 'reversal',
    eventId: `evt_${randomUUID()}`,
    eventType: 'refund.failed',
    scope: 'platform',
    accountReference: null,
    providerReference: tip.reference,
    chargeReference: tip.charge,
    operationReference: `tipme-tip-refund-${refundId}`,
    partnerReversalId: `refund.re_${randomUUID().slice(0, 8)}`,
    disputeWon: false,
    refundState: 'failed',
    refundedMinor: null,
    refundFeeMinor: null,
  };
  const outcome = await service().applyBachs(event, reads(tip));
  assert.match(outcome, /^tip_refund_/);
  assert.equal(
    (await q(`SELECT status FROM tip_refunds WHERE id = $1`, [refundId]))[0]
      .status,
    'FAILED',
  );
  // Never stored as a payment event or a Pro event, and nothing new booked.
  assert.equal(
    (
      await q(`SELECT 1 FROM provider_events WHERE provider_event_id = $1`, [
        event.eventId,
      ])
    ).length,
    0,
  );
  assert.equal((await transactionsOf(tip.tipId)).length, 1);
});

/** Today's ledger lines of a direct ₦2,000 tip to Ada, captured from dev before this task. */
const DIRECT_GOLDEN = [
  line('platform_fee_revenue', 'tipme', 'credit', 7000n),
  line('provider_clearing', 'tipme', 'debit', 198500n),
  line('provider_fee_expense', 'tipme', 'debit', 1500n),
  line('provider_fee_recovered', 'tipme', 'credit', 3000n),
  line('recipient_payable', 'person', 'credit', 190000n),
];

for (const switchOn of [false, true])
  test(`a direct tip's payment is booked exactly as before (switch ${switchOn ? 'on' : 'off'})`, async () => {
    await setSwitch(database.pool, 'you_collect', switchOn);
    const { db } = database;
    await ops.beginPaymentAccountCreation(db, {
      profileId: ADA,
      provider: 'bachs',
      environment: 'sandbox',
    });
    await ops.updatePaymentAccountStatus(db, {
      profileId: ADA,
      provider: 'bachs',
      environment: 'sandbox',
      providerAccountReference: 'acct_ada123',
      status: 'ACTIVE',
      chargesEnabled: true,
      payoutsEnabled: false,
      feeCollector: 'platform',
      requirementsDue: [],
    });
    const quote = await ops.createQuote(db, {
      handle: 'ada',
      tipMinor: 200000n,
      currency: 'NGN',
    });
    assert.equal(quote.collectionMode, 'direct');
    const { attemptId, tipId } = await ops.createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = 'acct_ada123:chk_paid';
    await ops.markAttemptInitiated(db, {
      attemptId,
      provider: 'bachs',
      providerReference: reference,
    });
    const expectations = [];
    const outcome = await service().applyBachs(
      {
        kind: 'payment',
        eventId: `evt_${randomUUID()}`,
        eventType: 'collection.succeeded',
        providerReference: reference,
        operationReference: attemptId,
        accountReference: 'acct_ada123',
        status: 'pending',
        amountMinor: 200000n,
        currency: 'NGN',
        feeMinor: 1500n,
        feePaidBy: 'unknown',
      },
      {
        environment: 'sandbox',
        async verifyTransaction(_reference, expectation) {
          expectations.push(expectation);
          return {
            status: 'succeeded',
            amountMinor: 200000n,
            currency: 'NGN',
            feeMinor: 1500n,
          };
        },
      },
    );
    assert.equal(outcome, 'confirmed');
    // Still read back against TipMe's whole quoted share, as before.
    assert.deepEqual(expectations, [{ platformFeeMinor: 10000n }]);
    assert.deepEqual(await linesOf(tipId), DIRECT_GOLDEN);
    assert.equal((await transfersOf(tipId)).length, 0);
    assert.equal(
      (await q(`SELECT 1 FROM share_transfers WHERE tip_id = $1`, [tipId]))
        .length,
      0,
    );
  });

test('a misreported amount on a collect tip is never booked', async () => {
  const tip = await collectTip();
  const outcome = await service().applyBachs(
    collection(tip),
    reads(tip, { amountMinor: GROSS - 1n }),
  );
  assert.notEqual(outcome, 'confirmed');
  const [attempt] = await q(
    `SELECT status FROM payment_attempts WHERE id = $1`,
    [tip.attemptId],
  );
  assert.equal(attempt.status, 'UNKNOWN');
  assert.notEqual(await tipStatusOf(tip.tipId), 'SUCCEEDED');
  assert.equal((await transactionsOf(tip.tipId)).length, 0);
  assert.equal((await transfersOf(tip.tipId)).length, 0);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'payment.mismatch' AND aggregate_id = $1`,
        [tip.attemptId],
      )
    ).length,
    1,
  );
});

test('a collect tip with a business share holds the share for the business and schedules only the leg into the business', async () => {
  await setSwitch(database.pool, 'business', true);
  await setSwitch(database.pool, 'business_shares', true);
  const { businessId, locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
  });
  await seedAgreement(database, { memberId, businessBps: 2000 });
  const tip = await collectTip({ shared: { memberId } });
  const [{ share_minor: shareText }] = await q(
    `SELECT share_minor::text FROM tip_business_shares WHERE tip_id = $1`,
    [tip.tipId],
  );
  const share = BigInt(shareText);
  assert.ok(share > 0n && share < NET);
  assert.equal(
    await service().applyBachs(collection(tip), reads(tip)),
    'confirmed',
  );

  const held = (await linesOf(tip.tipId)).filter(
    (line) => line.code === 'held_for_recipients',
  );
  assert.deepEqual(held, [
    {
      type: 'payment',
      code: 'held_for_recipients',
      owner: 'business',
      side: 'debit',
      amount: share.toString(),
    },
    {
      type: 'payment',
      code: 'held_for_recipients',
      owner: 'person',
      side: 'debit',
      amount: (NET - share).toString(),
    },
  ]);
  // The staff member's transfer moves their part only.
  const [transfer] = await transfersOf(tip.tipId);
  assert.equal(transfer.amount, (NET - share).toString());
  assert.equal(transfer.business_id, null);
  // The share is already in TipMe's balance: one collect_sweep, the leg in only, never a sweep.
  const sweeps = await q(
    `SELECT kind, status, business_id, amount_minor::text AS amount, deliver_minor::text AS deliver
       FROM share_transfers WHERE tip_id = $1`,
    [tip.tipId],
  );
  assert.deepEqual(sweeps, [
    {
      kind: 'collect_sweep',
      status: 'out_paid',
      business_id: businessId,
      amount: share.toString(),
      deliver: share.toString(),
    },
  ]);

  // The worker runs it once settled: TipMe sends the share into the business's account only.
  const calls = [];
  // The tip was paid on the partner, so its share moves there (a stand-in that names each account
  // by its owner's id).
  const partner = {
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: false },
    async payoutBalance() {
      return { availableMinor: 0n };
    },
    async collectToPlatform(input) {
      calls.push(['collect', input]);
      throw new Error('the out leg must never run for a collect share');
    },
    async transferToAccount(input) {
      calls.push(['send', input.accountRef, input.amountMinor]);
      return { transferRef: 'tr_1', status: 'paid' };
    },
    async findPlatformCollection() {
      return null;
    },
  };
  // Not before the tip has settled in TipMe's balance.
  await ops.runShareTransfers(database.db, {
    provider: partner,
    now: new Date(),
    settleWaitMs: DAY,
  });
  assert.deepEqual(calls, []);
  await ops.runShareTransfers(database.db, {
    provider: partner,
    now: new Date(Date.now() + DAY + HOUR),
    settleWaitMs: DAY,
  });
  assert.deepEqual(calls, [['send', businessId, share]]);
  assert.equal(
    (
      await q(`SELECT status FROM share_transfers WHERE tip_id = $1`, [
        tip.tipId,
      ])
    )[0].status,
    'done',
  );
  // Sent: the business's held money is now in its own partner balance.
  const moved = (await linesOf(tip.tipId)).filter(
    (line) => line.type === 'collect_transfer',
  );
  assert.deepEqual(moved, [
    {
      type: 'collect_transfer',
      code: 'held_for_recipients',
      owner: 'business',
      side: 'credit',
      amount: share.toString(),
    },
    {
      type: 'collect_transfer',
      code: 'provider_clearing',
      owner: 'tipme',
      side: 'debit',
      amount: share.toString(),
    },
  ]);
  // Run again: nothing moves twice, nothing is booked twice.
  await ops.runShareTransfers(database.db, {
    provider: partner,
    now: new Date(Date.now() + 2 * DAY),
    settleWaitMs: DAY,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    (await transactionsOf(tip.tipId)).filter(
      (row) => row.type === 'collect_transfer',
    ).length,
    1,
  );
});

test("a new recipient's transfer waits 24 hours; after 7 days it is released at settlement", async () => {
  const settledAt = new Date('2026-11-20T10:00:00.000Z');
  const confirm = async (tip) => {
    const result = await ops.reconcileAttempts({
      db: database.db,
      provider: reads(tip),
      now: settledAt,
      minAgeMs: 0,
      attemptId: tip.attemptId,
    });
    assert.equal(result.applied, 1);
    return (await transfersOf(tip.tipId))[0].release_after;
  };
  // Signed up a day before the tip settled: the default delay (24 hours, first 7 days).
  await q(`UPDATE profiles SET created_at = $1 WHERE id = $2`, [
    new Date(settledAt.getTime() - DAY),
    TOBI.id,
  ]);
  assert.deepEqual(
    await confirm(await collectTip()),
    new Date(settledAt.getTime() + 24 * HOUR),
  );
  // Signed up eight days before: released when the tip settles.
  await q(`UPDATE profiles SET created_at = $1 WHERE id = $2`, [
    new Date(settledAt.getTime() - 8 * DAY),
    TOBI.id,
  ]);
  assert.deepEqual(await confirm(await collectTip()), settledAt);
});

test('a pretend collect checkout can be paid in development, and books held money', async (t) => {
  const stack = await startStack({ databaseUrl: database.url });
  t.after(() => stack.stop());
  const post = async (path, body) => {
    const response = await fetch(`${stack.api}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  // Tobi has no partner account: decided collect on this quote (R7).
  const quote = await post('/v1/tip-quotes', {
    handle: 'tobi',
    amountMinor: '200000',
    currency: 'NGN',
  });
  assert.equal(quote.status, 201);
  const intent = await post('/v1/tip-intents', {
    quoteId: quote.body.data.quoteId,
  });
  assert.equal(intent.status, 201);
  const reference = decodeURIComponent(
    intent.body.data.checkoutUrl.split('/mock-checkout/')[1],
  );
  assert.match(reference, /^platform:mock_collect_[0-9a-f-]{36}$/);
  const path = `/v1/mock-provider/checkout/${encodeURIComponent(reference)}`;
  const summary = await fetch(`${stack.api}${path}`);
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).data.amountMinor, '200000');
  const paid = await post(path, { outcome: 'succeed' });
  assert.equal(paid.status, 201);
  const { tipId } = intent.body.data;
  assert.equal(await tipStatusOf(tipId), 'SUCCEEDED');
  assert.equal(
    (await linesOf(tipId)).some(
      (line) => line.code === 'held_for_recipients' && line.side === 'debit',
    ),
    true,
  );
  const [transfer] = await transfersOf(tipId);
  assert.equal(transfer.provider, 'mock');
  assert.equal(transfer.status, 'waiting');
  // A reference of another shape is still refused.
  const unknown = await fetch(
    `${stack.api}/v1/mock-provider/checkout/${encodeURIComponent(`platform:mock_collect_${randomUUID()}`)}`,
  );
  assert.equal(unknown.status, 404);
  const odd = await fetch(
    `${stack.api}/v1/mock-provider/checkout/${encodeURIComponent('platform:cs_123')}`,
  );
  assert.equal(odd.status, 404);
});
