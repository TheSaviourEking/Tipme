import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  autoResolveIssues,
  balanceOf,
  createPaymentIntent,
  createQuote,
  mailForDomainEvent,
  mailSealing,
  markAttemptInitiated,
  PAYOUT_NOT_FOUND_AFTER_MS,
  PAYOUT_UNEXPECTED_AFTER_MS,
  reconcilePayouts,
  recordProviderEvent,
  requestWithdrawal,
  runIssueDetectors,
  seedDemoProfiles,
  startPayout,
} from '../../packages/database/dist/index.js';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';
import {
  PayoutRejectedError,
  UncertainProviderOutcomeError,
} from '../../packages/payments/dist/index.js';

// The money path, against a scripted provider: nothing here reaches a payment provider.

const ACCOUNT = 'acct_tobi';
const FEE = 5000n;
const sealing = mailSealing(Buffer.alloc(32, 7));
const timeout = () =>
  new UncertainProviderOutcomeError('op', 'no response', {
    cause: 'no_response',
  });

/** Records every money write. Reads answer from `state`, which each test scripts. */
function scripted(overrides = {}) {
  const provider = {
    name: 'bachs-sandbox',
    environment: 'sandbox',
    capabilities: { connectedAccounts: true },
    calls: [],
    found: null,
    status: { status: 'pending' },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance() {
      return { availableMinor: 900000n };
    },
    async quotePayoutFee() {
      return { feeMinor: FEE, exact: false };
    },
    async coverPayoutFee(input) {
      provider.calls.push({ call: 'fee', ...input });
      return { transferRef: `tr_${input.idempotencyKey}` };
    },
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      return {
        providerReference: `${ACCOUNT}:po_${input.payoutId}`,
        status: 'pending',
      };
    },
    async findPayoutByReference(accountRef, payoutId) {
      provider.calls.push({ call: 'find', accountRef, payoutId });
      return provider.found;
    },
    async fetchPayoutStatus(reference) {
      provider.calls.push({ call: 'read', reference });
      return provider.status;
    },
    ...overrides,
  };
  return provider;
}
const writes = (provider) =>
  provider.calls.filter(({ call }) => call === 'fee' || call === 'payout');

async function fixture(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  // Two ₦10,000 tips collected through the payment provider.
  for (let i = 0; i < 2; i += 1) {
    const quote = await createQuote(db, {
      handle: 'tobi',
      tipMinor: 1000000n,
      currency: 'NGN',
    });
    const intent = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = `${ACCOUNT}:chk_${randomUUID().slice(0, 8)}`;
    await markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'bachs',
      providerReference: reference,
    });
    await recordProviderEvent(db, {
      provider: 'bachs',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: 1000000n,
      currency: 'NGN',
      providerFeeMinor: 15000n,
      signatureVerified: true,
      payload: {},
    });
  }
  await q(
    `INSERT INTO payment_accounts
       (id, profile_id, provider, environment, provider_account_reference, status,
        charges_enabled, payouts_enabled, fee_collector)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform')`,
    [randomUUID(), TOBI, ACCOUNT],
  );
  await q(
    `INSERT INTO payout_destinations
       (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', 'ba_tobi', '058', 'Guaranty Trust Bank', '4321', 'usable')`,
    [randomUUID(), TOBI],
  );
  const withdraw = async (amountMinor = 200000n) =>
    (
      await requestWithdrawal(db, {
        profileId: TOBI,
        amountMinor,
        idempotencyKey: randomUUID(),
        provider: scripted(),
      })
    ).payoutId;
  const row = async (payoutId) =>
    (await q('SELECT * FROM payouts WHERE id = $1', [payoutId]))[0];
  const issues = (kind) => q('SELECT * FROM issues WHERE kind = $1', [kind]);
  const holds = () =>
    q('SELECT * FROM withdrawal_holds WHERE released_at IS NULL');
  const available = async () => (await balanceOf(db, TOBI)).availableMinor;
  const ledger = (payoutId) =>
    q(
      `SELECT t.operation_key, a.code, e.side, e.amount_minor::text AS amount
         FROM ledger_transactions t
         JOIN ledger_entries e ON e.transaction_id = t.id
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE t.payout_id = $1 ORDER BY t.operation_key, a.code`,
      [payoutId],
    );
  const paidEvent = (payoutId, extra = {}) => ({
    kind: 'payout',
    eventId: `evt_${randomUUID()}`,
    eventType: 'payout.paid',
    providerReference: `${ACCOUNT}:po_${payoutId}`,
    accountReference: ACCOUNT,
    status: 'paid',
    ...extra,
  });
  const failedEvent = (payoutId, extra = {}) =>
    paidEvent(payoutId, {
      eventType: 'payout.failed',
      status: 'failed',
      ...extra,
    });
  const webhooks = new WebhookService({ db }, sealing);
  const reconcile = (provider, now = new Date()) =>
    reconcilePayouts({ db, provider, now, minAgeMs: 0 });
  return {
    db,
    q,
    withdraw,
    row,
    issues,
    holds,
    available,
    ledger,
    paidEvent,
    failedEvent,
    webhooks,
    reconcile,
  };
}

const after = (ms) => new Date(Date.now() + ms + 1000);

test('a payout starts with the fee transfer, then the payout, each with its own key', async (t) => {
  const { db, withdraw, row, q } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  assert.equal(await startPayout(db, { payoutId, provider }), 'started');
  assert.deepEqual(provider.calls, [
    {
      call: 'fee',
      accountRef: ACCOUNT,
      feeMinor: FEE,
      currency: 'NGN',
      idempotencyKey: `payout-fee.${payoutId}`,
    },
    {
      call: 'payout',
      payoutId,
      accountRef: ACCOUNT,
      destinationRef: 'ba_tobi',
      amountMinor: 200000n,
      currency: 'NGN',
      idempotencyKey: `payout.${payoutId}`,
    },
  ]);
  const payout = await row(payoutId);
  assert.equal(payout.status, 'PROCESSING');
  assert.equal(payout.provider, 'bachs');
  assert.equal(payout.provider_reference, `${ACCOUNT}:po_${payoutId}`);
  assert.equal(payout.fee_transfer_reference, `tr_payout-fee.${payoutId}`);
  assert.equal(payout.start_uncertain_at, null);
  const [credit] = await q('SELECT * FROM provider_fee_credits');
  assert.equal(credit.payout_id, payoutId);
  assert.equal(credit.used_by_payout_id, null);
  // A redelivered job changes nothing.
  assert.equal(await startPayout(db, { payoutId, provider }), 'already');
  assert.equal(writes(provider).length, 2);
});

test('paid posts the payout and the fee as its own TipMe cost line', async (t) => {
  const { db, withdraw, row, q, ledger, paidEvent, webhooks } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  assert.equal(
    await webhooks.applyBachs(paidEvent(payoutId), provider),
    'applied',
  );
  assert.equal((await row(payoutId)).status, 'PAID');
  assert.deepEqual(await ledger(payoutId), [
    {
      operation_key: `payout-fee.${payoutId}`,
      code: 'provider_clearing',
      side: 'credit',
      amount: '5000',
    },
    {
      operation_key: `payout-fee.${payoutId}`,
      code: 'provider_fee_expense',
      side: 'debit',
      amount: '5000',
    },
    {
      operation_key: `payout.${payoutId}`,
      code: 'provider_clearing',
      side: 'credit',
      amount: '200000',
    },
    {
      operation_key: `payout.${payoutId}`,
      code: 'recipient_payable',
      side: 'debit',
      amount: '200000',
    },
  ]);
  const [credit] = await q('SELECT * FROM provider_fee_credits');
  assert.equal(credit.used_by_payout_id, payoutId);
});

test('failed releases the reservation and emails withdrawal_failed', async (t) => {
  const { db, withdraw, row, available, failedEvent, webhooks, q } =
    await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  assert.equal(await available(), before - 200000n);
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  provider.status = { status: 'failed', failureReason: 'destination' };
  assert.equal(
    await webhooks.applyBachs(failedEvent(payoutId), provider),
    'applied',
  );
  assert.equal((await row(payoutId)).status, 'FAILED');
  assert.equal(await available(), before);
  const [{ user_id: userId }] = await q(
    'SELECT user_id FROM profiles WHERE id = $1',
    [TOBI],
  );
  await q(
    'UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2',
    ['tobi@example.com', userId],
  );
  await mailForDomainEvent(db, sealing, 'payout.failed', {
    payoutId,
    profileId: TOBI,
  });
  const mails = (await queuedMail(db, sealing, { limit: 50 })).filter(
    (m) => m.type === 'withdrawal_failed',
  );
  assert.equal(mails.length, 1);
  assert.doesNotMatch(JSON.stringify(mails[0]), /bachs/i);
  assert.ok(
    (await q(`SELECT dedupe_key FROM outbox_events`)).some(
      (e) => e.dedupe_key === `payout.failed.${payoutId}`,
    ),
  );
});

test('a first refusal is definite: it releases at once and the payout is failed', async (t) => {
  const { db, withdraw, row, available, q } = await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout() {
      throw new PayoutRejectedError('other', 'INSUFFICIENT_BALANCE');
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'failed');
  const payout = await row(payoutId);
  assert.equal(payout.status, 'FAILED');
  assert.equal(payout.provider_reference, null);
  assert.equal(await available(), before);
  assert.ok(
    (await q('SELECT dedupe_key FROM outbox_events')).some(
      (e) => e.dedupe_key === `payout.failed.${payoutId}`,
    ),
  );
});

test('a refusal of the fee transfer moved nothing: the payout fails without being sent', async (t) => {
  const { db, withdraw, row, available } = await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  const provider = scripted({
    async coverPayoutFee() {
      throw new PayoutRejectedError('other', 'INSUFFICIENT_BALANCE');
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'failed');
  assert.equal((await row(payoutId)).status, 'FAILED');
  assert.equal(writes(provider).length, 0);
  assert.equal(await available(), before);
});

test('in debt opens provider_in_debt and pauses withdrawals', async (t) => {
  const { db, withdraw, row, issues, holds, failedEvent, webhooks } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  provider.status = { status: 'failed', failureReason: 'in_debt' };
  await webhooks.applyBachs(failedEvent(payoutId), provider);
  assert.equal((await row(payoutId)).status, 'FAILED');
  const [issue] = await issues('provider_in_debt');
  assert.ok(issue);
  const active = await holds();
  assert.equal(active.length, 1);
  assert.equal(active[0].reason, 'in_debt');
  assert.equal(active[0].issue_id, issue.id);
  await assert.rejects(
    requestWithdrawal(db, {
      profileId: TOBI,
      amountMinor: 200000n,
      idempotencyKey: randomUUID(),
      provider: scripted(),
    }),
    { code: 'WITHDRAWALS_PAUSED' },
  );
});

test('a debt refusal on the first attempt pauses withdrawals too', async (t) => {
  const { db, withdraw, holds, issues } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout() {
      throw new PayoutRejectedError('in_debt', 'ORGANIZATION_IN_DEBT');
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'failed');
  assert.equal((await issues('provider_in_debt')).length, 1);
  assert.equal((await holds()).length, 1);
});

test('held for review stays processing and says so', async (t) => {
  const { db, withdraw, row, reconcile } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout(input) {
      return {
        providerReference: `${ACCOUNT}:po_${input.payoutId}`,
        status: 'review',
      };
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'started');
  assert.equal((await row(payoutId)).status, 'PROCESSING');
  const { recentActivity } =
    await import('../../packages/database/dist/index.js');
  const state = async () =>
    (await recentActivity(db, TOBI, 10)).find((a) => a.id === payoutId).state;
  assert.equal(await state(), 'in_review');
  // Reconciliation keeps it current: once the provider moves on, it no longer says so.
  provider.status = { status: 'pending' };
  await reconcile(provider);
  assert.equal(await state(), 'processing');
  provider.status = { status: 'review' };
  await reconcile(provider);
  assert.equal(await state(), 'in_review');
});

test('a timeout leaves the payout unknown, and reconciliation resolves it without a second payout', async (t) => {
  const { db, withdraw, row, available, reconcile } = await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      throw timeout();
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'uncertain');
  const uncertain = await row(payoutId);
  assert.equal(uncertain.status, 'REQUESTED');
  assert.ok(uncertain.start_uncertain_at);
  assert.equal(await available(), before - 200000n);

  // Not found yet is not proof while the request may still be in flight.
  await reconcile(provider);
  assert.equal((await row(payoutId)).status, 'REQUESTED');

  provider.found = {
    providerReference: `${ACCOUNT}:po_found`,
    status: 'pending',
    feeMinor: FEE,
  };
  await reconcile(provider);
  const found = await row(payoutId);
  assert.equal(found.status, 'PROCESSING');
  assert.equal(found.provider_reference, `${ACCOUNT}:po_found`);
  assert.equal(
    provider.calls.filter(({ call }) => call === 'payout').length,
    1,
  );
});

test('a timed-out start found already paid settles it; found failed releases it', async (t) => {
  const { db, withdraw, row, available, reconcile, ledger } = await fixture(t);
  const before = await available();
  const first = await withdraw();
  const provider = scripted({
    async initiatePayout() {
      throw timeout();
    },
  });
  await startPayout(db, { payoutId: first, provider });
  provider.found = {
    providerReference: `${ACCOUNT}:po_a`,
    status: 'failed',
    failureReason: 'other',
  };
  await reconcile(provider);
  assert.equal((await row(first)).status, 'FAILED');
  assert.equal(await available(), before);

  const second = await withdraw();
  await startPayout(db, { payoutId: second, provider });
  provider.found = {
    providerReference: `${ACCOUNT}:po_b`,
    status: 'paid',
    feeMinor: FEE,
  };
  await reconcile(provider);
  assert.equal((await row(second)).status, 'PAID');
  assert.equal((await ledger(second)).length, 4);
});

test('a redelivered job after a timeout reads first and never calls the provider again', async (t) => {
  const { db, withdraw, row, available } = await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  let refuse = false;
  const provider = scripted({
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      if (refuse)
        throw new PayoutRejectedError('other', 'INSUFFICIENT_BALANCE');
      throw timeout();
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'uncertain');
  // Bachs does not promise to replay an error: a later refusal could not prove anything.
  refuse = true;
  assert.equal(await startPayout(db, { payoutId, provider }), 'uncertain');
  assert.equal(
    provider.calls.filter(({ call }) => call === 'payout').length,
    1,
  );
  assert.equal(provider.calls.filter(({ call }) => call === 'find').length, 1);
  assert.equal((await row(payoutId)).status, 'REQUESTED');
  assert.equal(await available(), before - 200000n);
  // What the read finds decides it.
  provider.found = { providerReference: `${ACCOUNT}:po_x`, status: 'pending' };
  assert.equal(await startPayout(db, { payoutId, provider }), 'started');
  assert.equal((await row(payoutId)).status, 'PROCESSING');
});

test('a crash after the provider call leaves a mark, so a redelivery only reads', async (t) => {
  const { db, withdraw, row } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      // The mark must already be committed when the request leaves.
      assert.ok((await row(payoutId)).start_uncertain_at);
      throw new Error('the worker died here');
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'uncertain');
  assert.equal(await startPayout(db, { payoutId, provider }), 'uncertain');
  assert.equal(
    provider.calls.filter(({ call }) => call === 'payout').length,
    1,
  );
});

test('no payout found long after an uncertain start opens one issue and keeps the reservation', async (t) => {
  const { db, withdraw, row, available, issues, reconcile } = await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      throw timeout();
    },
  });
  await startPayout(db, { payoutId, provider });
  await reconcile(provider);
  assert.equal((await issues('payout_unresolved')).length, 0);
  const late = after(PAYOUT_NOT_FOUND_AFTER_MS);
  await reconcile(provider, late);
  await reconcile(provider, late);
  assert.equal((await issues('payout_unresolved')).length, 1);
  assert.equal((await row(payoutId)).status, 'REQUESTED');
  assert.equal(await available(), before - 200000n);
  assert.equal(
    provider.calls.filter(({ call }) => call === 'payout').length,
    1,
  );
  // Once the payout turns up, the issue clears.
  provider.found = {
    providerReference: `${ACCOUNT}:po_late`,
    status: 'pending',
  };
  await reconcile(provider, late);
  await autoResolveIssues(db, late);
  assert.equal((await issues('payout_unresolved'))[0].status, 'resolved');
});

test('a webhook before the start response is applied once the reference is recorded', async (t) => {
  const {
    db,
    withdraw,
    row,
    issues,
    holds,
    paidEvent,
    webhooks,
    q,
    reconcile,
  } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  const event = paidEvent(payoutId);
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  await runIssueDetectors(db, new Date());
  assert.equal((await issues('unmatched_event')).length, 0);
  await reconcile(provider);
  assert.equal((await issues('payout_unexpected')).length, 0);
  await startPayout(db, { payoutId, provider });
  assert.equal((await row(payoutId)).status, 'PROCESSING');
  await reconcile(provider, after(PAYOUT_UNEXPECTED_AFTER_MS));
  assert.equal((await row(payoutId)).status, 'PAID');
  assert.equal((await issues('payout_unexpected')).length, 0);
  assert.equal((await holds()).length, 0);
  assert.equal(
    writes(provider).filter(({ call }) => call === 'payout').length,
    1,
  );
  const stored = await q(
    'SELECT 1 FROM provider_events WHERE provider_event_id = $1',
    [event.eventId],
  );
  assert.equal(stored.length, 1);
});

test('a duplicate payout.paid webhook changes nothing', async (t) => {
  const { db, withdraw, paidEvent, webhooks, ledger, q } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  const event = paidEvent(payoutId);
  assert.equal(await webhooks.applyBachs(event, provider), 'applied');
  assert.equal(await webhooks.applyBachs(event, provider), 'duplicate');
  assert.equal((await ledger(payoutId)).length, 4);
  assert.equal(
    (await q(`SELECT 1 FROM outbox_events WHERE event_type = 'payout.paid'`))
      .length,
    1,
  );
});

test('a failed payout after a top-up reuses the top-up next time', async (t) => {
  const { db, withdraw, q, row, paidEvent, webhooks, available } =
    await fixture(t);
  const start = await available();
  const first = await withdraw();
  const refusing = scripted({
    async initiatePayout() {
      throw new PayoutRejectedError('destination', 'DESTINATION_REJECTED');
    },
  });
  assert.equal(
    await startPayout(db, { payoutId: first, provider: refusing }),
    'failed',
  );
  assert.equal(await available(), start);
  assert.equal((await q('SELECT * FROM provider_fee_credits')).length, 1);

  const second = await withdraw();
  const provider = scripted();
  assert.equal(
    await startPayout(db, { payoutId: second, provider }),
    'started',
  );
  assert.deepEqual(
    provider.calls.map(({ call }) => call),
    ['payout'],
  );
  assert.equal(
    (await row(second)).fee_transfer_reference,
    `tr_payout-fee.${first}`,
  );

  // Spoken for by the second payout, so a third pays its own way.
  const third = await withdraw();
  const other = scripted();
  await startPayout(db, { payoutId: third, provider: other });
  assert.deepEqual(
    other.calls.map(({ call }) => call),
    ['fee', 'payout'],
  );

  await webhooks.applyBachs(paidEvent(second), provider);
  const [credit] = await q(
    'SELECT used_by_payout_id FROM provider_fee_credits WHERE payout_id = $1',
    [first],
  );
  assert.equal(credit.used_by_payout_id, second);
});

test('two workers starting the same payout make one provider call', async (t) => {
  const { db, withdraw, row } = await fixture(t);
  for (let i = 0; i < 5; i += 1) {
    const payoutId = await withdraw(100000n);
    const provider = scripted({
      async initiatePayout(input) {
        provider.calls.push({ call: 'payout', ...input });
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          providerReference: `${ACCOUNT}:po_${input.payoutId}`,
          status: 'pending',
        };
      },
    });
    const results = await Promise.all([
      startPayout(db, { payoutId, provider }),
      startPayout(db, { payoutId, provider }),
    ]);
    assert.ok(results.includes('started'), results.join());
    assert.equal(
      provider.calls.filter(({ call }) => call === 'payout').length,
      1,
    );
    assert.equal(provider.calls.filter(({ call }) => call === 'fee').length, 1);
    assert.equal((await row(payoutId)).status, 'PROCESSING');
  }
});

test('a payout TipMe never started opens payout_unexpected and pauses withdrawals', async (t) => {
  const { db, issues, holds, webhooks, paidEvent, reconcile, q } =
    await fixture(t);
  const provider = scripted();
  const event = paidEvent('never');
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  await reconcile(provider);
  assert.equal((await issues('payout_unexpected')).length, 0);
  assert.equal((await holds()).length, 0);
  const late = after(PAYOUT_UNEXPECTED_AFTER_MS);
  await reconcile(provider, late);
  await reconcile(provider, late);
  const [issue] = await issues('payout_unexpected');
  assert.ok(issue);
  assert.equal((await issues('payout_unexpected')).length, 1);
  const active = await holds();
  assert.equal(active.length, 1);
  assert.equal(active[0].reason, 'unexpected_payout');
  assert.equal(active[0].issue_id, issue.id);
  assert.equal((await q('SELECT 1 FROM payouts')).length, 0);
  await assert.rejects(
    requestWithdrawal(db, {
      profileId: TOBI,
      amountMinor: 200000n,
      idempotencyKey: randomUUID(),
      provider: scripted(),
    }),
    { code: 'WITHDRAWALS_PAUSED' },
  );
});

test('a payout webhook for an account that is not ours is kept and changes nothing', async (t) => {
  const { webhooks, paidEvent, reconcile, issues, holds } = await fixture(t);
  const provider = scripted();
  const event = paidEvent('x', {
    accountReference: 'acct_stranger',
    providerReference: 'acct_stranger:po_x',
  });
  assert.equal(await webhooks.applyBachs(event, provider), 'unmatched');
  await reconcile(provider, after(PAYOUT_UNEXPECTED_AFTER_MS));
  assert.equal((await issues('payout_unexpected')).length, 0);
  assert.equal((await holds()).length, 0);
});

test('a contradiction is read back: the read decides, not the event', async (t) => {
  const { db, withdraw, row, available, paidEvent, webhooks, ledger } =
    await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  provider.status = { status: 'failed', failureReason: 'other' };
  const contradicted = paidEvent(payoutId, { contradicted: true });
  assert.equal(await webhooks.applyBachs(contradicted, provider), 'applied');
  assert.equal((await row(payoutId)).status, 'FAILED');
  assert.equal(await available(), before);
  assert.equal((await ledger(payoutId)).length, 0);
});

test('a contradiction with no final read applies nothing, and a 404 is not a failure', async (t) => {
  const { db, withdraw, row, failedEvent, paidEvent, webhooks } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  provider.status = { status: 'pending' };
  await webhooks.applyBachs(
    paidEvent(payoutId, { contradicted: true }),
    provider,
  );
  assert.equal((await row(payoutId)).status, 'PROCESSING');
  provider.status = { status: 'not_found' };
  await webhooks.applyBachs(failedEvent(payoutId), provider);
  assert.equal((await row(payoutId)).status, 'PROCESSING');
  // A read that fails is the same: reconciliation keeps checking.
  provider.fetchPayoutStatus = async () => {
    throw timeout();
  };
  await webhooks.applyBachs(failedEvent(payoutId), provider);
  assert.equal((await row(payoutId)).status, 'PROCESSING');
});

test('a fee above what was covered opens a money issue and the actual fee is the cost', async (t) => {
  const { db, withdraw, row, issues, ledger, paidEvent, webhooks } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout(input) {
      return {
        providerReference: `${ACCOUNT}:po_${input.payoutId}`,
        status: 'pending',
        feeMinor: 7500n,
      };
    },
  });
  await startPayout(db, { payoutId, provider });
  assert.equal((await row(payoutId)).fee_minor, '7500');
  const [issue] = await issues('payout_fee_short');
  assert.equal(issue.severity, 'money');
  await webhooks.applyBachs(paidEvent(payoutId), provider);
  const cost = (await ledger(payoutId)).filter(
    (line) => line.code === 'provider_fee_expense',
  );
  assert.deepEqual(
    cost.map((line) => line.amount),
    ['7500'],
  );
});

test('a hold that appeared after the request stops the start and shows it to staff', async (t) => {
  const { db, withdraw, row, q, issues, available } = await fixture(t);
  const before = await available();
  const payoutId = await withdraw();
  const issueId = randomUUID();
  await q(
    `INSERT INTO issues (id, kind, dedupe_key, severity, subject, summary, opened_at)
     VALUES ($1, 'payment_reversed', $2, 'money', $3, 'test', now())`,
    [issueId, `test.${issueId}`, JSON.stringify({ profileId: TOBI })],
  );
  await q(
    `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id) VALUES ($1, $2, 'reversal', $3)`,
    [randomUUID(), TOBI, issueId],
  );
  const provider = scripted();
  assert.equal(await startPayout(db, { payoutId, provider }), 'held');
  assert.equal(provider.calls.length, 0);
  const payout = await row(payoutId);
  assert.equal(payout.status, 'REQUESTED');
  assert.equal(payout.start_uncertain_at, null);
  assert.equal(await available(), before - 200000n);
  assert.equal((await issues('payout_held')).length, 1);
  assert.equal(await startPayout(db, { payoutId, provider }), 'held');
  assert.equal((await issues('payout_held')).length, 1);
});

test('a payout on the pretend provider has no account, bank or fee', async (t) => {
  const { db, q, ledger, row } = await fixture(t);
  const { createMockProvider } =
    await import('../../packages/payments/dist/index.js');
  const { Redis } = await import('./helpers.mjs');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const provider = createMockProvider({
    redis,
    prefix: `ps-${randomUUID().slice(0, 8)}`,
  });
  const payoutId = randomUUID();
  await q(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint, provider, fee_minor)
     VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'mock', 5000)`,
    [payoutId, TOBI, randomUUID()],
  );
  assert.equal(await startPayout(db, { payoutId, provider }), 'started');
  assert.equal((await row(payoutId)).fee_transfer_reference, null);
  await reconcilePayouts({ db, provider, now: new Date(), minAgeMs: 0 });
  assert.equal((await row(payoutId)).status, 'PAID');
  assert.equal((await ledger(payoutId)).length, 2);
});
