import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  autoResolveIssues,
  balanceOf,
  holdWithdrawals,
  markPayoutFailedAbsent,
  openIssue,
  createPaymentIntent,
  createQuote,
  mailForDomainEvent,
  mailSealing,
  markAttemptInitiated,
  openUnexpectedPayout,
  PAYOUT_NOT_FOUND_AFTER_MS,
  PAYOUT_STUCK_AFTER_MS,
  PAYOUT_UNEXPECTED_AFTER_MS,
  reconcilePayouts,
  requeuePayoutsWaitingOnPlatform,
  reportProviderKeyRefused,
  recordPayoutFee,
  recordPayoutOutcome,
  recordProviderEvent,
  requestWithdrawal,
  runIssueDetectors,
  seedDemoProfiles,
  setPayoutReview,
  startPayout,
} from '../../packages/database/dist/index.js';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';
import {
  PayoutRejectedError,
  PlatformRefusalError,
  UncertainProviderOutcomeError,
} from '../../packages/payments/dist/index.js';

import {
  createDatabase,
  isDatabaseAvailabilityFailure,
} from '../../packages/database/dist/index.js';
import { jobFailure } from '../../apps/worker/dist/job-retry.js';
import { startPgGate } from './pg-gate.mjs';

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
      return { availableMinor: 1800000n };
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
      tipMinor: 2000000n,
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
      amountMinor: 2000000n,
      currency: 'NGN',
      providerFeeMinor: 30000n,
      signatureVerified: true,
      payload: {},
    });
  }
  await q(
    `INSERT INTO payment_accounts
       (id, profile_id, provider, environment, provider_account_reference, status,
        charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform', now())`,
    [randomUUID(), TOBI, ACCOUNT],
  );
  await q(
    `INSERT INTO payout_destinations
       (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', 'ba_tobi', '058', 'Guaranty Trust Bank', '4321', 'usable')`,
    [randomUUID(), TOBI],
  );
  const withdraw = async (amountMinor = 400000n) =>
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
    url: database.url,
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
      amountMinor: 400000n,
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

test('a connection lost right after the provider accepted: the retry reads, never sends again', async (t) => {
  const { url, withdraw, row, db } = await fixture(t);
  const payoutId = await withdraw();
  const gate = await startPgGate(url);
  const handle = createDatabase(gate.url, { max: 1 });
  t.after(async () => {
    await handle.close();
    await gate.close();
  });
  const provider = scripted({
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      gate.fill(); // The money left; the database goes away before it's written down.
      return {
        providerReference: `${ACCOUNT}:po_${input.payoutId}`,
        status: 'pending',
      };
    },
  });
  provider.found = {
    providerReference: `${ACCOUNT}:po_${payoutId}`,
    status: 'pending',
    feeMinor: FEE,
  };
  const failed = await startPayout(handle.db, { payoutId, provider }).catch(
    (error) => error,
  );
  assert.equal(writes(provider).filter((w) => w.call === 'payout').length, 1);
  assert.equal(isDatabaseAvailabilityFailure(failed), true, String(failed));
  assert.equal(jobFailure('payout.start', failed), failed);
  gate.drain();
  await new Promise((resolve) => setTimeout(resolve, 700));
  // What the queue's next try does.
  await startPayout(handle.db, { payoutId, provider });
  await startPayout(db, { payoutId, provider });
  assert.equal(
    writes(provider).filter((w) => w.call === 'payout').length,
    1,
    'sent twice',
  );
  assert.equal(
    (await row(payoutId)).provider_reference,
    provider.found.providerReference,
    JSON.stringify(provider.calls.map(({ call }) => call)),
  );
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
      amount: '400000',
    },
    {
      operation_key: `payout.${payoutId}`,
      code: 'recipient_payable',
      side: 'debit',
      amount: '400000',
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
  assert.equal(await available(), before - 400000n);
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
      amountMinor: 400000n,
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
  assert.equal(await available(), before - 400000n);

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
  assert.equal(await available(), before - 400000n);
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
  assert.equal(await available(), before - 400000n);
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
    const payoutId = await withdraw(200000n);
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
      amountMinor: 400000n,
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
  assert.equal(await available(), before - 400000n);
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

// ---- Review round 1 ----

const timingOut = (overrides = {}) => {
  const provider = scripted({
    async initiatePayout(input) {
      provider.calls.push({ call: 'payout', ...input });
      throw timeout();
    },
    ...overrides,
  });
  return provider;
};

for (const [label, wrong] of [
  ['amount', { amountMinor: 999n, currency: 'NGN' }],
  ['currency', { amountMinor: 400000n, currency: 'USD' }],
  [
    'destination',
    { amountMinor: 400000n, currency: 'NGN', destinationRef: 'ba_other' },
  ],
]) {
  test(`a lookup with the wrong ${label} is not booked: conflict, and the money stays reserved`, async (t) => {
    const { db, withdraw, row, issues, ledger, available, reconcile } =
      await fixture(t);
    const payoutId = await withdraw();
    const reserved = await available();
    const provider = timingOut();
    await startPayout(db, { payoutId, provider });
    provider.found = {
      providerReference: `${ACCOUNT}:po_w`,
      status: 'paid',
      ...wrong,
    };
    await reconcile(provider);
    const payout = await row(payoutId);
    assert.equal(payout.status, 'REQUESTED');
    assert.equal(payout.provider_reference, null);
    assert.equal((await ledger(payoutId)).length, 0);
    assert.equal(await available(), reserved);
    assert.equal((await issues('payout_conflict')).length, 1);
  });
}

test('a matching lookup is still applied', async (t) => {
  const { db, withdraw, row, reconcile } = await fixture(t);
  const payoutId = await withdraw();
  const provider = timingOut();
  await startPayout(db, { payoutId, provider });
  provider.found = {
    providerReference: `${ACCOUNT}:po_ok`,
    status: 'paid',
    amountMinor: 400000n,
    currency: 'NGN',
    destinationRef: 'ba_tobi',
  };
  await reconcile(provider);
  assert.equal((await row(payoutId)).status, 'PAID');
});

test('a status read with the wrong amount is not booked', async (t) => {
  const { db, withdraw, row, issues, ledger, reconcile } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  provider.status = { status: 'paid', amountMinor: 1n, currency: 'NGN' };
  await reconcile(provider);
  assert.equal((await row(payoutId)).status, 'PROCESSING');
  assert.equal((await ledger(payoutId)).length, 0);
  assert.equal((await issues('payout_conflict')).length, 1);
});

for (const [label, wrong] of [
  // The docs leave open whether data.amount includes the fee: 200000 + 5000 looks gross.
  ['a gross-looking amount', { amountMinor: 410000n, currency: 'NGN' }],
  ['the wrong currency', { amountMinor: 400000n, currency: 'USD' }],
]) {
  test(`a signed payout.paid with ${label} books once if the read agrees, with no issue`, async (t) => {
    const { db, withdraw, row, issues, ledger, paidEvent, webhooks } =
      await fixture(t);
    const payoutId = await withdraw();
    const provider = scripted();
    await startPayout(db, { payoutId, provider });
    provider.status = {
      status: 'paid',
      amountMinor: 400000n,
      currency: 'NGN',
      destinationRef: 'ba_tobi',
    };
    const event = paidEvent(payoutId, wrong);
    assert.equal(await webhooks.applyBachs(event, provider), 'applied');
    assert.equal(await webhooks.applyBachs(event, provider), 'duplicate');
    assert.equal((await row(payoutId)).status, 'PAID');
    assert.equal((await ledger(payoutId)).length, 4);
    assert.equal((await issues('payout_conflict')).length, 0);
  });

  test(`a signed payout.paid with ${label} books nothing if the read disagrees, and says which field`, async (t) => {
    const { db, withdraw, row, issues, ledger, paidEvent, webhooks } =
      await fixture(t);
    const payoutId = await withdraw();
    const provider = scripted();
    await startPayout(db, { payoutId, provider });
    provider.status = { status: 'paid', amountMinor: 1n, currency: 'NGN' };
    assert.equal(
      await webhooks.applyBachs(paidEvent(payoutId, wrong), provider),
      'conflict',
    );
    assert.equal((await row(payoutId)).status, 'PROCESSING');
    assert.equal((await ledger(payoutId)).length, 0);
    const [issue] = await issues('payout_conflict');
    assert.match(issue.summary, /amount/);
    assert.doesNotMatch(issue.summary, /200000|205000/);
  });
}

test('a disagreeing event with a read that has no answer, or no figures, changes nothing', async (t) => {
  const { db, withdraw, row, issues, paidEvent, webhooks } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  const event = paidEvent(payoutId, { amountMinor: 1n, currency: 'NGN' });
  for (const status of [
    { status: 'pending' },
    { status: 'not_found' },
    { status: 'paid' },
  ]) {
    provider.status = status;
    await webhooks.applyBachs(event, provider);
    assert.equal((await row(payoutId)).status, 'PROCESSING');
  }
  assert.equal((await issues('payout_conflict')).length, 0);
});

test('a matching signed payout.paid is applied, with the fee it states', async (t) => {
  const { db, withdraw, row, ledger, paidEvent, webhooks } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  const event = paidEvent(payoutId, {
    amountMinor: 400000n,
    currency: 'NGN',
    feeMinor: 6000n,
    operationReference: payoutId,
  });
  assert.equal(await webhooks.applyBachs(event, provider), 'applied');
  assert.equal((await row(payoutId)).status, 'PAID');
  assert.ok(
    (await ledger(payoutId)).some(
      (l) => l.code === 'provider_fee_expense' && l.amount === '6000',
    ),
  );
});

test('two references for one payout stay a conflict that closes only by hand', async (t) => {
  const { db, withdraw, issues } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  const { applyFoundPayout } =
    await import('../../packages/database/dist/index.js');
  await applyFoundPayout(
    db,
    { id: payoutId, provider: 'bachs' },
    { providerReference: `${ACCOUNT}:po_second`, status: 'pending' },
    new Date(),
  );
  await autoResolveIssues(db, new Date());
  const [issue] = await issues('payout_conflict');
  assert.equal(issue.status, 'open');
});

test('a lookup that keeps erroring reaches staff past the wait, and nothing is released', async (t) => {
  const { db, withdraw, row, issues, reconcile, available } = await fixture(t);
  const payoutId = await withdraw();
  const reserved = await available();
  const provider = timingOut({
    async findPayoutByReference() {
      throw timeout();
    },
  });
  await startPayout(db, { payoutId, provider });
  await reconcile(provider);
  assert.equal((await issues('payout_unresolved')).length, 0);
  const result = await reconcile(provider, after(PAYOUT_NOT_FOUND_AFTER_MS));
  assert.equal(result.errors, 1);
  assert.equal((await issues('payout_unresolved')).length, 1);
  assert.equal((await row(payoutId)).status, 'REQUESTED');
  assert.equal(await available(), reserved);
});

test('two payouts with our reference is a conflict at once', async (t) => {
  const { db, withdraw, row, issues, reconcile } = await fixture(t);
  const payoutId = await withdraw();
  const ambiguous = () => {
    const error = timeout();
    error.name = 'AmbiguousPayoutError';
    return error;
  };
  const provider = timingOut({
    async findPayoutByReference() {
      throw ambiguous();
    },
  });
  await startPayout(db, { payoutId, provider });
  await reconcile(provider);
  assert.equal((await issues('payout_conflict')).length, 1);
  assert.equal((await row(payoutId)).status, 'REQUESTED');
});

for (const [label, status] of [
  ['stays pending', { status: 'pending' }],
  ['keeps answering not found', { status: 'not_found' }],
]) {
  test(`a referenced payout that ${label} reaches staff, and the issue does not close itself`, async (t) => {
    const { db, withdraw, row, issues, reconcile } = await fixture(t);
    const payoutId = await withdraw();
    const provider = scripted();
    await startPayout(db, { payoutId, provider });
    provider.status = status;
    await reconcile(provider);
    assert.equal((await issues('payout_unresolved')).length, 0);
    const late = after(PAYOUT_STUCK_AFTER_MS);
    await reconcile(provider, late);
    await reconcile(provider, late);
    assert.equal((await issues('payout_unresolved')).length, 1);
    await autoResolveIssues(db, late);
    assert.equal((await issues('payout_unresolved'))[0].status, 'open');
    assert.equal((await row(payoutId)).status, 'PROCESSING');
    // A final answer does close it.
    provider.status = { status: 'paid' };
    await reconcile(provider, late);
    await autoResolveIssues(db, late);
    assert.equal((await issues('payout_unresolved'))[0].status, 'resolved');
  });
}

test('a parked event naming our payout is never unexpected, even through a long outage', async (t) => {
  const { db, withdraw, row, issues, holds, paidEvent, webhooks, reconcile } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = timingOut();
  await startPayout(db, { payoutId, provider });
  const event = paidEvent(payoutId, {
    operationReference: payoutId,
    amountMinor: 400000n,
    currency: 'NGN',
  });
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  // Reads down for hours: the mark is older than any wait, and it stays parked.
  provider.fetchPayoutStatus = async () => {
    throw timeout();
  };
  provider.findPayoutByReference = async () => {
    throw timeout();
  };
  await reconcile(provider, after(PAYOUT_NOT_FOUND_AFTER_MS * 2));
  assert.equal((await issues('payout_unexpected')).length, 0);
  assert.equal((await holds()).length, 0);
  // Reads back: the payout is adopted after a read, then settled by the event.
  provider.fetchPayoutStatus = async () => ({
    status: 'paid',
    amountMinor: 400000n,
    currency: 'NGN',
  });
  await reconcile(provider, after(PAYOUT_NOT_FOUND_AFTER_MS * 2));
  const payout = await row(payoutId);
  assert.equal(payout.status, 'PAID');
  assert.equal(payout.provider_reference, event.providerReference);
  assert.equal((await holds()).length, 0);
});

test('an event naming another account’s payout does not adopt it', async (t) => {
  const { withdraw, row, issues, holds, paidEvent, webhooks, reconcile, q } =
    await fixture(t);
  const payoutId = await withdraw();
  await q(`UPDATE payouts SET account_reference = 'acct_other' WHERE id = $1`, [
    payoutId,
  ]);
  const provider = scripted();
  await webhooks.applyBachs(
    paidEvent('zzz', { operationReference: payoutId }),
    provider,
  );
  await reconcile(provider, after(PAYOUT_UNEXPECTED_AFTER_MS));
  assert.equal((await row(payoutId)).provider_reference, null);
  assert.equal((await issues('payout_unexpected')).length, 1);
  assert.equal((await holds()).length, 1);
});

test('opening payout_unexpected rechecks in its transaction: a payout recorded meanwhile stops it', async (t) => {
  const { db, withdraw, issues, holds } = await fixture(t);
  const payoutId = await withdraw();
  await startPayout(db, { payoutId, provider: scripted() });
  await openUnexpectedPayout(db, {
    unmatchedId: randomUUID(),
    accountReference: ACCOUNT,
    providerReference: `${ACCOUNT}:po_${payoutId}`,
    operationReference: null,
    now: after(PAYOUT_NOT_FOUND_AFTER_MS),
  });
  assert.equal((await issues('payout_unexpected')).length, 0);
  assert.equal((await holds()).length, 0);
});

test('the step attempted is recorded and said in the issue; a lost fee answer says the payout was not sent', async (t) => {
  const { db, withdraw, row, issues, reconcile } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async coverPayoutFee() {
      throw timeout();
    },
  });
  const logs = [];
  await startPayout(db, {
    payoutId,
    provider,
    log: (entry) => logs.push(entry),
  });
  assert.equal((await row(payoutId)).start_step, 'fee');
  assert.deepEqual(logs, [
    {
      event: 'payout.start_uncertain',
      payout_id: payoutId,
      step: 'fee',
      error: 'UncertainProviderOutcomeError',
      cause: 'no_response',
    },
  ]);
  await reconcile(provider, after(PAYOUT_NOT_FOUND_AFTER_MS));
  const [issue] = await issues('payout_unresolved');
  assert.match(issue.summary, /fee top-up/);
  assert.match(issue.summary, /payout itself was not sent/);

  const second = await withdraw();
  const other = timingOut();
  await startPayout(db, { payoutId: second, provider: other });
  assert.equal((await row(second)).start_step, 'payout');
});

test('a top-up that cannot be recorded logs its transfer reference', async (t) => {
  const { db, withdraw, row, q } = await fixture(t);
  const payoutId = await withdraw();
  // The credit's primary key is taken, with another account: the insert does nothing, so force a failure.
  await q(
    `CREATE FUNCTION test_refuse_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`,
  );
  await q(
    `CREATE TRIGGER test_refuse BEFORE INSERT ON provider_fee_credits FOR EACH ROW EXECUTE FUNCTION test_refuse_credit()`,
  );
  const logs = [];
  const provider = scripted();
  assert.equal(
    await startPayout(db, {
      payoutId,
      provider,
      log: (entry) => logs.push(entry),
    }),
    'uncertain',
  );
  assert.equal(
    provider.calls.filter(({ call }) => call === 'payout').length,
    0,
  );
  assert.ok(
    logs.some(
      (e) =>
        e.event === 'payout.fee_unrecorded' &&
        e.transfer_ref === `tr_payout-fee.${payoutId}`,
    ),
  );
  assert.equal((await row(payoutId)).start_step, 'fee');
  await q(`DROP TRIGGER test_refuse ON provider_fee_credits`);
  await q(`DROP FUNCTION test_refuse_credit()`);
});

test('fee and review notes do not write on a finished payout', async (t) => {
  const { db, withdraw, row, paidEvent, webhooks } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  await webhooks.applyBachs(paidEvent(payoutId), provider);
  await recordPayoutFee(db, { payoutId, feeMinor: 9000n, now: new Date() });
  await setPayoutReview(db, { payoutId, inReview: true, now: new Date() });
  const payout = await row(payoutId);
  assert.equal(payout.fee_minor, '5000');
  assert.equal(payout.provider_review_at, null);
});

test('a parked paid event naming a released payout is a conflict at once, even with reads down', async (t) => {
  const {
    db,
    withdraw,
    row,
    issues,
    paidEvent,
    webhooks,
    reconcile,
    available,
  } = await fixture(t);
  const payoutId = await withdraw();
  await startPayout(db, {
    payoutId,
    provider: scripted({
      async initiatePayout() {
        throw new PayoutRejectedError('other', 'INSUFFICIENT_BALANCE');
      },
    }),
  });
  const released = await available();
  const provider = scripted({
    async fetchPayoutStatus() {
      throw timeout();
    },
  });
  const event = paidEvent(payoutId, { operationReference: payoutId });
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  await reconcile(provider);
  await reconcile(provider);
  const conflicts = await issues('payout_conflict');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].subject.payoutId, payoutId);
  await autoResolveIssues(db, new Date());
  assert.equal((await issues('payout_conflict'))[0].status, 'open');
  assert.equal((await row(payoutId)).status, 'FAILED');
  assert.equal(await available(), released);
});

test('a parked event naming our payout under another reference is a conflict at once', async (t) => {
  const { db, withdraw, row, issues, paidEvent, webhooks, reconcile } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  const before = (await row(payoutId)).provider_reference;
  const event = paidEvent('another', { operationReference: payoutId });
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  await reconcile(provider);
  assert.equal((await issues('payout_conflict')).length, 1);
  assert.equal((await row(payoutId)).provider_reference, before);
  assert.equal((await row(payoutId)).status, 'PROCESSING');
});

test('a parked event that never gets an answer reaches staff at the age cap, once', async (t) => {
  const {
    db,
    withdraw,
    issues,
    holds,
    paidEvent,
    webhooks,
    reconcile,
    available,
  } = await fixture(t);
  const payoutId = await withdraw();
  const reserved = await available();
  const provider = scripted({
    async initiatePayout() {
      throw timeout();
    },
    async findPayoutByReference() {
      return null;
    },
    async fetchPayoutStatus() {
      return { status: 'not_found' };
    },
  });
  await startPayout(db, { payoutId, provider });
  await webhooks.applyBachs(
    paidEvent(payoutId, { operationReference: payoutId }),
    provider,
  );
  const parkedIssues = async () =>
    (await issues('payout_unresolved')).filter((i) =>
      i.dedupe_key.startsWith('payout_parked.'),
    );
  await reconcile(provider, after(PAYOUT_NOT_FOUND_AFTER_MS));
  assert.equal((await parkedIssues()).length, 0);
  const late = after(PAYOUT_STUCK_AFTER_MS);
  await reconcile(provider, late);
  await reconcile(provider, late);
  assert.equal((await parkedIssues()).length, 1);
  assert.equal((await holds()).length, 0);
  assert.equal(await available(), reserved);
});

test('fifty stuck parked events do not block a newer one', async (t) => {
  const { db, withdraw, issues, paidEvent, webhooks, reconcile } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout() {
      throw timeout();
    },
    async findPayoutByReference() {
      throw timeout();
    },
    async fetchPayoutStatus() {
      throw timeout();
    },
  });
  await startPayout(db, { payoutId, provider });
  for (let i = 0; i < 55; i += 1)
    await webhooks.applyBachs(
      paidEvent(`stuck${i}`, { operationReference: payoutId }),
      provider,
    );
  // Not named, so past the wait it is unexpected, if the sweep ever gets to it.
  await webhooks.applyBachs(paidEvent('newer'), provider);
  const late = after(PAYOUT_NOT_FOUND_AFTER_MS);
  await reconcile(provider, late);
  await reconcile(provider, new Date(late.getTime() + 1000));
  assert.equal((await issues('payout_unexpected')).length, 1);
});

test('an unreadable stored amount fails one parked row, not the sweep', async (t) => {
  const { db, withdraw, row, paidEvent, webhooks, reconcile } =
    await fixture(t);
  const provider = scripted();
  await webhooks.applyBachs(
    { ...paidEvent('bad'), amountMinor: 'lots' },
    provider,
  );
  const payoutId = await withdraw();
  await startPayout(db, { payoutId, provider });
  const good = paidEvent(payoutId);
  await webhooks.applyBachs(good, provider);
  assert.equal((await row(payoutId)).status, 'PAID');
  const result = await reconcile(provider);
  assert.equal(result.errors, 1);
});

// ---- Review round 3 ----

for (const [label, read, expected, status] of [
  [
    'the same reference',
    (id) => ({ operationReference: id }),
    'applied',
    'PAID',
  ],
  [
    'another reference',
    () => ({ operationReference: 'someone-else' }),
    'conflict',
    'PROCESSING',
  ],
  ['no reference', () => ({}), 'unread', 'PROCESSING'],
]) {
  test(`an event with a wrong reference and a read with ${label}: ${expected}`, async (t) => {
    const { db, withdraw, row, issues, ledger, paidEvent, webhooks } =
      await fixture(t);
    const payoutId = await withdraw();
    const provider = scripted();
    await startPayout(db, { payoutId, provider });
    provider.status = {
      status: 'paid',
      amountMinor: 400000n,
      currency: 'NGN',
      ...read(payoutId),
    };
    const event = paidEvent(payoutId, { operationReference: 'not-ours' });
    assert.equal(await webhooks.applyBachs(event, provider), expected);
    assert.equal((await row(payoutId)).status, status);
    assert.equal((await ledger(payoutId)).length, status === 'PAID' ? 4 : 0);
    assert.equal(
      (await issues('payout_conflict')).length,
      expected === 'conflict' ? 1 : 0,
    );
  });
}

test('a status read naming another reference is not booked or released', async (t) => {
  const { db, withdraw, row, issues, reconcile } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  provider.status = { status: 'failed', operationReference: 'someone-else' };
  await reconcile(provider);
  assert.equal((await row(payoutId)).status, 'PROCESSING');
  assert.match((await issues('payout_conflict'))[0].summary, /reference/);
});

test('after the age cap the row is still tried: a payout that then fails raises the conflict', async (t) => {
  const { db, withdraw, row, issues, paidEvent, webhooks, reconcile } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async initiatePayout() {
      throw timeout();
    },
    async fetchPayoutStatus() {
      return { status: 'not_found' };
    },
  });
  await startPayout(db, { payoutId, provider });
  await webhooks.applyBachs(
    paidEvent(payoutId, { operationReference: payoutId }),
    provider,
  );
  const late = after(PAYOUT_STUCK_AFTER_MS);
  await reconcile(provider, late);
  const capped = () =>
    issues('payout_unresolved').then((rows) =>
      rows.filter((i) => i.dedupe_key.startsWith('payout_parked.')),
    );
  assert.equal((await capped()).length, 1);
  await recordPayoutOutcome(db, {
    payoutId,
    provider: 'bachs',
    providerEventId: `staff.${payoutId}`,
    providerReference: null,
    outcome: 'failed',
    signatureVerified: true,
    payload: {},
  });
  assert.equal((await row(payoutId)).status, 'FAILED');
  await autoResolveIssues(db, late);
  assert.equal((await capped())[0].status, 'resolved');
  await reconcile(provider, late);
  const [conflict] = await issues('payout_conflict');
  assert.equal(conflict.status, 'open');
  assert.equal(conflict.subject.payoutId, payoutId);
});

test('a parked payout.failed naming a failed payout is no alarm, and leaves the queue', async (t) => {
  const { db, withdraw, issues, q, failedEvent, webhooks, reconcile } =
    await fixture(t);
  const payoutId = await withdraw();
  await startPayout(db, {
    payoutId,
    provider: scripted({
      async initiatePayout() {
        throw new PayoutRejectedError('other', 'INSUFFICIENT_BALANCE');
      },
    }),
  });
  const provider = scripted();
  const event = failedEvent(payoutId, { operationReference: payoutId });
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  await reconcile(provider);
  await reconcile(provider, after(PAYOUT_STUCK_AFTER_MS));
  assert.equal((await issues('payout_conflict')).length, 0);
  assert.equal((await issues('payout_unexpected')).length, 0);
  assert.equal(
    (
      await q('SELECT 1 FROM provider_events WHERE provider_event_id = $1', [
        event.eventId,
      ])
    ).length,
    1,
  );
});

test('a parked event naming a payout that already has its reference is that payout', async (t) => {
  const { db, withdraw, row, issues, q, paidEvent, webhooks, reconcile } =
    await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted();
  await startPayout(db, { payoutId, provider });
  const event = paidEvent(payoutId, { operationReference: payoutId });
  // Parked as if it arrived just before the reference was recorded, then the lookup missed it.
  await q(`UPDATE payouts SET provider = 'bachs_old' WHERE id = $1`, [
    payoutId,
  ]);
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  await reconcile(provider);
  assert.equal((await issues('payout_conflict')).length, 0);
  assert.equal((await row(payoutId)).status, 'PAID');
});

test('a rotation stamp that fails is counted', async (t) => {
  const { paidEvent, webhooks, reconcile, q } = await fixture(t);
  const provider = scripted();
  await webhooks.applyBachs(paidEvent('x'), provider);
  await q(
    `CREATE FUNCTION test_refuse_stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`,
  );
  await q(
    `CREATE TRIGGER test_refuse BEFORE INSERT ON parked_payout_checks FOR EACH ROW EXECUTE FUNCTION test_refuse_stamp()`,
  );
  const result = await reconcile(provider);
  await q(`DROP TRIGGER test_refuse ON parked_payout_checks`);
  await q(`DROP FUNCTION test_refuse_stamp()`);
  assert.equal(result.errors, 1);
});

test('a paid event after staff released a create that died is the conflict path, and books nothing', async (t) => {
  const {
    db,
    q,
    withdraw,
    row,
    issues,
    paidEvent,
    webhooks,
    reconcile,
    ledger,
    available,
  } = await fixture(t);
  const payoutId = await withdraw();
  const dead = scripted({
    async initiatePayout() {
      throw timeout();
    },
  });
  assert.equal(
    await startPayout(db, { payoutId, provider: dead }),
    'uncertain',
  );
  assert.equal((await row(payoutId)).start_step, 'payout');
  const dayOn = after(PAYOUT_STUCK_AFTER_MS);
  await reconcile(scripted(), after(PAYOUT_NOT_FOUND_AFTER_MS));
  const [unresolved] = await issues('payout_unresolved');
  const marked = await markPayoutFailedAbsent(db, {
    issueId: unresolved.id,
    staffUserId: '00000000-0000-7000-8000-00000000abcd',
    reason: 'Not in the provider dashboard, checked by hand.',
    dashboardVerified: true,
    provider: () => scripted(),
    now: dayOn,
  });
  assert.equal(marked.outcome, 'marked_failed');
  const released = await available();
  const ledgerBefore = await ledger(payoutId);

  const provider = scripted();
  const event = paidEvent(payoutId, { operationReference: payoutId });
  assert.equal(await webhooks.applyBachs(event, provider), 'parked');
  await reconcile(provider);
  const conflicts = await issues('payout_conflict');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].status, 'open');
  assert.equal(conflicts[0].subject.payoutId, payoutId);
  assert.equal((await row(payoutId)).status, 'FAILED');
  assert.equal(await available(), released);
  assert.deepEqual(await ledger(payoutId), ledgerBefore);
  assert.ok(q);
});

const emptyReserve = (code = 'INSUFFICIENT_BALANCE') =>
  new PlatformRefusalError('reserve_empty', code);

test('an empty reserve holds the withdrawal: no failure, no email, one issue and one alert', async (t) => {
  const { db, q, withdraw, row, issues, available } = await fixture(t);
  const reserved = await available();
  const first = await withdraw();
  const second = await withdraw();
  const held = await available();
  assert.ok(held < reserved);
  const provider = scripted({
    async coverPayoutFee(input) {
      provider.calls.push({ call: 'fee', ...input });
      throw emptyReserve();
    },
  });
  for (const payoutId of [first, second])
    assert.equal(
      await startPayout(db, { payoutId, provider }),
      'waiting_on_platform',
    );
  assert.equal(
    writes(provider).filter(({ call }) => call === 'payout').length,
    0,
  );
  for (const payoutId of [first, second]) {
    const payout = await row(payoutId);
    assert.equal(payout.status, 'REQUESTED');
    // A definite answer: nothing is in doubt, so nothing says it may have left.
    assert.equal(payout.start_uncertain_at, null);
    assert.equal(payout.start_step, null);
    assert.ok(payout.platform_wait_since);
  }
  assert.equal(await available(), held);
  assert.equal((await issues('payout_failed')).length, 0);
  const outbox = await q('SELECT event_type FROM outbox_events');
  assert.equal(
    outbox.filter((e) => e.event_type === 'payout.failed').length,
    0,
  );
  assert.equal(
    outbox.filter((e) => e.event_type === 'payouts.platform_refused').length,
    1,
  );
  const open = await issues('reserve_empty');
  assert.equal(open.length, 1);
  assert.equal(open[0].severity, 'money');
});

test('a timeout on the top-up is not an empty reserve: it stays uncertain and is never re-sent', async (t) => {
  const { db, withdraw, row, issues } = await fixture(t);
  const payoutId = await withdraw();
  const provider = scripted({
    async coverPayoutFee(input) {
      provider.calls.push({ call: 'fee', ...input });
      throw timeout();
    },
  });
  assert.equal(await startPayout(db, { payoutId, provider }), 'uncertain');
  const payout = await row(payoutId);
  assert.ok(payout.start_uncertain_at);
  assert.equal(payout.start_step, 'fee');
  assert.equal(payout.platform_wait_since, null);
  assert.equal((await issues('reserve_empty')).length, 0);
  // Funding the reserve doesn't touch it.
  assert.equal((await requeuePayoutsWaitingOnPlatform(db)).queued, 0);
  assert.equal(writes(provider).length, 1);
});

test('once funded it resumes under a new key, the issue closes itself, and a later spell opens a new one', async (t) => {
  const { db, q, withdraw, row, issues } = await fixture(t);
  const payoutId = await withdraw();
  const refusing = scripted({
    async coverPayoutFee(input) {
      refusing.calls.push({ call: 'fee', ...input });
      throw emptyReserve('ORGANIZATION_IN_DEBT');
    },
  });
  const t0 = new Date();
  await startPayout(db, { payoutId, provider: refusing, now: t0 });

  // Nothing closes it, or calls the wait a lost job, while it waits.
  await autoResolveIssues(db, new Date());
  assert.equal((await issues('reserve_empty'))[0].status, 'open');
  await reconcilePayouts({
    db,
    provider: scripted(),
    now: after(PAYOUT_NOT_FOUND_AFTER_MS),
    minAgeMs: 0,
  });
  assert.equal((await issues('payout_unresolved')).length, 0);

  assert.equal((await requeuePayoutsWaitingOnPlatform(db)).queued, 1);
  const queued = await q(
    `SELECT dedupe_key FROM outbox_events WHERE event_type = 'payouts.start' AND aggregate_id = $1`,
    [payoutId],
  );
  assert.equal(queued.length, 2);

  // The first key stays spent on a refusal, which a provider may replay for good.
  const provider = scripted();
  assert.equal(await startPayout(db, { payoutId, provider }), 'started');
  assert.notEqual(
    refusing.calls[0].idempotencyKey,
    provider.calls[0].idempotencyKey,
  );
  assert.match(
    provider.calls[0].idempotencyKey,
    new RegExp(`^payout-fee\\.${payoutId}\\.`),
  );
  assert.equal((await row(payoutId)).status, 'PROCESSING');
  assert.equal(writes(refusing).length, 1);

  await autoResolveIssues(db, new Date());
  assert.equal((await issues('reserve_empty'))[0].status, 'resolved');
  assert.equal((await requeuePayoutsWaitingOnPlatform(db)).queued, 0);

  const next = await withdraw();
  await startPayout(db, { payoutId: next, provider: refusing });
  assert.equal(
    (await issues('reserve_empty')).filter((i) => i.status === 'open').length,
    1,
  );
});

test('a hold or the switch still stops a waiting payout when the reserve is funded', async (t) => {
  const { db, q, withdraw, issues } = await fixture(t);
  const payoutId = await withdraw();
  await startPayout(db, {
    payoutId,
    provider: scripted({
      async coverPayoutFee() {
        throw emptyReserve();
      },
    }),
  });
  const cause = await openIssue(db, {
    dedupeKey: `hold.${randomUUID()}`,
    kind: 'payment_reversed',
    subject: { profileId: TOBI },
    now: new Date(),
  });
  await db.transaction((tx) =>
    holdWithdrawals(tx, {
      profileId: TOBI,
      reason: 'reversal',
      issueId: cause.id,
    }),
  );
  // A person decides it now: its own issue says so, and funding the reserve doesn't queue it.
  assert.equal((await issues('payout_held')).length, 1);
  assert.equal((await requeuePayoutsWaitingOnPlatform(db)).queued, 0);
  const provider = scripted();
  assert.equal(await startPayout(db, { payoutId, provider }), 'held');
  assert.equal(writes(provider).length, 0);
  // That payout is no longer the reserve's to answer for.
  await autoResolveIssues(db, new Date());
  assert.equal((await issues('reserve_empty'))[0].status, 'resolved');

  await q(`DELETE FROM issues WHERE kind = 'payout_held'`);
  await q(`UPDATE withdrawal_holds SET released_at = now()`);
  await q(`UPDATE withdrawals_switch SET paused = true`);
  assert.equal((await requeuePayoutsWaitingOnPlatform(db)).queued, 0);
});

test('a key the provider refuses holds the withdrawal too, on either call, with its own issue', async (t) => {
  const { db, q, withdraw, row, issues } = await fixture(t);
  const keyRefused = (code) => new PlatformRefusalError('provider_key', code);
  const onFee = await withdraw();
  const onPayout = await withdraw();
  assert.equal(
    await startPayout(db, {
      payoutId: onFee,
      provider: scripted({
        async coverPayoutFee() {
          throw keyRefused('UNAUTHORIZED');
        },
      }),
    }),
    'waiting_on_platform',
  );
  assert.equal(
    await startPayout(db, {
      payoutId: onPayout,
      provider: scripted({
        async initiatePayout() {
          throw keyRefused('FORBIDDEN');
        },
      }),
    }),
    'waiting_on_platform',
  );
  assert.equal((await row(onFee)).status, 'REQUESTED');
  assert.equal((await row(onPayout)).status, 'REQUESTED');
  // The top-up that did go through is recorded, so the next try doesn't pay it again.
  assert.ok((await row(onPayout)).fee_transfer_reference);
  assert.equal((await issues('payout_failed')).length, 0);
  const open = await issues('provider_key_refused');
  assert.equal(open.length, 1);
  assert.equal(
    (await q(`SELECT 1 FROM outbox_events WHERE event_type = 'payout.failed'`))
      .length,
    0,
  );
  // Another report while it is open adds nothing.
  await reportProviderKeyRefused(db, { now: new Date() });
  assert.equal((await issues('provider_key_refused')).length, 1);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'payouts.platform_refused'`,
      )
    ).length,
    1,
  );
});
