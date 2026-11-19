import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import {
  CollectTransferRefusedError,
  DisputeEvidenceRefusedError,
  UncertainProviderOutcomeError,
  createMockProvider,
  planScenario,
  runScenario,
  verifySignature,
} from '../../dist/index.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
after(() => redis.quit());
const secret = 'test-secret-that-is-at-least-32-chars!!';
const provider = () =>
  createMockProvider({
    redis,
    secret,
    prefix: `t-${randomUUID().slice(0, 8)}`,
  });

test('payments start pending, report the mock fee, and can be resolved', async () => {
  const mock = provider();
  const { providerReference } = await mock.initializePayment({
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
  });
  assert.match(providerReference, /^mock_pay_/);
  assert.deepEqual(await mock.verifyTransaction(providerReference), {
    status: 'pending',
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
  });
  await mock.markStatus(providerReference, 'succeeded');
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
  assert.equal(
    (await mock.verifyTransaction('mock_pay_nope')).status,
    'not_found',
  );
});

test('starting the same attempt twice returns the same payment, found by the attempt id', async () => {
  const mock = provider();
  const attemptId = randomUUID();
  const input = { attemptId, amountMinor: 100000n, currency: 'NGN' };
  // Two starts at once (a retry racing a timed-out first call) still make one payment.
  const [first, second] = await Promise.all([
    mock.initializePayment(input),
    mock.initializePayment(input),
  ]);
  assert.equal(first.providerReference, second.providerReference);
  assert.deepEqual(await mock.findPayment(attemptId), {
    providerReference: first.providerReference,
  });
  assert.equal(await mock.findPayment(randomUUID()), null);
});

test('a no-reply payment is captured silently', async () => {
  const mock = provider();
  const { providerReference } = await mock.initializePayment({
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
    scenario: 'no-reply',
  });
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
});

test('scenario plans match the agreed behaviours', () => {
  const payment = {
    reference: 'mock_pay_x',
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
  };
  const types = (scenario) =>
    planScenario(scenario, payment).map((step) => step.body.type);
  assert.deepEqual(types('succeed'), ['payment.pending', 'payment.succeeded']);
  assert.deepEqual(types('decline'), ['payment.failed']);
  assert.deepEqual(types('out-of-order'), [
    'payment.succeeded',
    'payment.pending',
  ]);
  const duplicate = planScenario('duplicate', payment);
  assert.equal(duplicate.length, 2);
  assert.equal(duplicate[0].body.id, duplicate[1].body.id);
  assert.equal(
    planScenario('wrong-amount', payment)[0].body.data.amountMinor,
    '99999',
  );
  assert.equal(planScenario('forged', payment)[0].signed, false);
  assert.deepEqual(planScenario('no-reply', payment), []);
  assert.ok(planScenario('pending-then-succeed', payment)[1].delayMs >= 500);
});

test('the simulator signs real deliveries and mis-signs forged ones', async (t) => {
  const received = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      received.push(
        verifySignature(
          Buffer.from(raw),
          request.headers['x-mock-signature'],
          secret,
          new Date(),
        ),
      );
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const payment = {
    reference: 'mock_pay_x',
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
  };
  assert.deepEqual(
    await runScenario({
      plan: planScenario('succeed', payment),
      webhookUrl: url,
      secret,
    }),
    [200, 200],
  );
  await runScenario({
    plan: planScenario('forged', payment),
    webhookUrl: url,
    secret,
  });
  assert.deepEqual(received, ['ok', 'ok', 'bad_signature']);
});

test('the outcome can be chosen once, on the pretend checkout page', async () => {
  const mock = provider();
  const { providerReference } = await mock.initializePayment({
    attemptId: randomUUID(),
    amountMinor: 100000n,
    currency: 'NGN',
  });
  assert.equal(await mock.chooseScenario(providerReference, 'no-reply'), true);
  // A no-reply payment is captured silently: only the status check reveals it.
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
  assert.equal(await mock.chooseScenario(providerReference, 'decline'), false);
  await mock.settle(providerReference);
  assert.equal(
    (await mock.verifyTransaction(providerReference)).status,
    'succeeded',
  );
  assert.equal(await mock.chooseScenario('mock_pay_unknown', 'succeed'), false);
});

// You collect (plan Task 4): the pretend partner's collect checkout, transfers, destinations and
// TipMe's own balances. Each scenario answers once, keyed like markAmount, then the partner pays.
const collectInput = (key, accountRef = 'mock_acct_person') => ({
  accountRef,
  amountMinor: 950000n,
  currency: 'NGN',
  idempotencyKey: key,
});

test('the pretend partner answers each collect scenario once, then pays', async () => {
  const mock = provider();
  const refusals = {
    'collect-insufficient': ['insufficient', 'INSUFFICIENT_BALANCE'],
    'collect-forbidden': ['capability', 'FORBIDDEN'],
    'collect-in-debt': ['in_debt', 'ORGANIZATION_IN_DEBT'],
    'collect-not-found': ['not_found', 'NOT_FOUND'],
  };
  for (const [scenario, [reason, code]] of Object.entries(refusals)) {
    const key = `tipme-collect-${randomUUID()}`;
    await mock.markCollectAnswer(key, scenario);
    await assert.rejects(
      mock.sendCollectTransfer(collectInput(key)),
      (error) =>
        error instanceof CollectTransferRefusedError &&
        error.reason === reason &&
        error.providerCode === code,
      scenario,
    );
    // Refused: nothing moved, so the account lists nothing for this key.
    assert.equal(
      (await mock.listAccountTransfers('mock_acct_person')).some(
        (transfer) => transfer.group === key,
      ),
      false,
    );
    const paid = await mock.sendCollectTransfer(collectInput(key));
    assert.equal(paid.status, 'paid');
  }

  // No reply: the transfer exists, its answer is lost; the same key replays it, the list has it.
  const lost = `tipme-collect-${randomUUID()}`;
  await mock.markCollectAnswer(lost, 'collect-no-reply');
  await assert.rejects(
    mock.sendCollectTransfer(collectInput(lost)),
    (error) =>
      error instanceof UncertainProviderOutcomeError &&
      error.diagnostic?.cause === 'no_response',
  );
  const listedLost = (await mock.listAccountTransfers('mock_acct_person')).find(
    (transfer) => transfer.group === lost,
  );
  assert.equal(listedLost.amountMinor, 950000n);
  const replay = await mock.sendCollectTransfer(collectInput(lost));
  assert.equal(replay.transferRef, listedLost.transferRef);

  // Mismatch: the partner moved other money; the read-back shows what it moved.
  const odd = `tipme-collect-${randomUUID()}`;
  await mock.markCollectAnswer(odd, 'collect-mismatch');
  await assert.rejects(
    mock.sendCollectTransfer(collectInput(odd)),
    (error) =>
      error instanceof UncertainProviderOutcomeError &&
      error.diagnostic?.cause === 'unexpected_state',
  );
  const listedOdd = (await mock.listAccountTransfers('mock_acct_person')).find(
    (transfer) => transfer.group === odd,
  );
  assert.notEqual(listedOdd.amountMinor, 950000n);
  // As live: the same key replays the same (mismatched) transfer, so it stays uncertain.
  await assert.rejects(
    mock.sendCollectTransfer(collectInput(odd)),
    (error) =>
      error instanceof UncertainProviderOutcomeError &&
      error.diagnostic?.cause === 'unexpected_state',
  );

  // The list honours transfer_group and the account: another account's transfer is not in it.
  const elsewhere = `tipme-collect-${randomUUID()}`;
  await mock.sendCollectTransfer(collectInput(elsewhere, 'mock_acct_other'));
  const mine = await mock.listAccountTransfers('mock_acct_person');
  assert.equal(
    mine.some((transfer) => transfer.group === elsewhere),
    false,
  );
  assert.equal(
    new Set(mine.map((transfer) => transfer.group)).size,
    mine.length,
  );
});

test('the pretend partner reviews or rejects a destination once, as told', async () => {
  const mock = provider();
  const bank = {
    accountNumber: '0123456789',
    accountName: 'ADA OKAFOR',
    bankCode: '058',
  };
  for (const [scenario, status] of [
    ['destination-pending-review', 'pending_review'],
    ['destination-rejected', 'rejected'],
  ]) {
    const account = `mock_acct_${randomUUID().slice(0, 8)}`;
    await mock.markCollectAnswer(account, scenario);
    const added = await mock.addPayoutDestination(account, bank);
    assert.deepEqual(
      { status: added.status, usable: added.usable },
      { status, usable: false },
    );
    assert.equal(
      await mock.payoutDestinationStatus(account, added.destinationRef),
      status,
    );
    // Used once: the next bank account added is usable.
    const next = await mock.addPayoutDestination(account, {
      ...bank,
      accountNumber: '0123451111',
    });
    assert.equal(next.status, 'usable');
  }
});

test('TipMe’s pretend balances and payout schedule can be set, signed', async () => {
  const mock = provider();
  assert.deepEqual(await mock.platformPayoutSchedule(), { NGN: 'manual' });
  await mock.markCollectAnswer('platform', 'auto-payout-on');
  assert.deepEqual(await mock.platformPayoutSchedule(), { NGN: 'daily' });
  assert.deepEqual(await mock.platformPayoutSchedule(), { NGN: 'manual' });

  const [ngn] = await mock.platformBalances();
  assert.equal(ngn.currency, 'NGN');
  await mock.markPlatformBalances([
    { currency: 'NGN', availableMinor: 500000n, pendingMinor: 100n },
  ]);
  assert.deepEqual(await mock.platformBalances(), [
    { currency: 'NGN', availableMinor: 500000n, pendingMinor: 100n },
  ]);
  await mock.markCollectAnswer('platform', 'balance-usd-negative');
  assert.deepEqual(await mock.platformBalances(), [
    { currency: 'NGN', availableMinor: 500000n, pendingMinor: 100n },
    { currency: 'USD', availableMinor: -1500n, pendingMinor: 0n },
  ]);
  assert.equal((await mock.platformBalances()).length, 1);
});

test('a pretend collect checkout is on TipMe’s own account, one per attempt, read with its charge', async () => {
  const mock = provider();
  const attemptId = randomUUID();
  const input = {
    attemptId,
    amountMinor: 1000000n,
    currency: 'NGN',
    successUrl: 'http://localhost:3000/return',
    cancelUrl: 'http://localhost:3000/cancel',
    idempotencyKey: `tipme-checkout-${attemptId}`,
  };
  const [first, again] = await Promise.all([
    mock.initializeCollectCheckout(input),
    mock.initializeCollectCheckout(input),
  ]);
  assert.match(first.providerReference, /^platform:mock_collect_/);
  assert.equal(first.providerReference, again.providerReference);
  assert.deepEqual(await mock.findPayment(attemptId), {
    providerReference: first.providerReference,
  });
  await mock.markStatus(first.providerReference, 'succeeded');
  const read = await mock.verifyTransaction(first.providerReference);
  assert.equal(read.status, 'succeeded');
  assert.equal(read.method, 'NGN_CARD');
  assert.equal(read.feePaidBy, 'platform');
  assert.equal(read.chargeReference, `mock_ch_${first.providerReference}`);
});

test('the pretend partner raises a dispute on TipMe’s own charge, takes evidence once, and decides it', async (t) => {
  const mock = provider();
  const { providerReference } = await mock.initializeCollectCheckout({
    attemptId: randomUUID(),
    amountMinor: 1000000n,
    currency: 'NGN',
    successUrl: 'https://usetipme.xyz/r',
    cancelUrl: 'https://usetipme.xyz/c',
    idempotencyKey: randomUUID(),
  });
  const { chargeReference } = await mock.verifyTransaction(providerReference);
  const since = new Date(Date.now() - 1000);
  const respondBy = new Date('2026-12-02T00:00:00.000Z');
  const opened = await mock.raiseDispute({
    chargeReference,
    amountMinor: 1000000n,
    currency: 'NGN',
    respondBy,
  });
  assert.equal(opened.type, 'dispute.created');
  assert.equal(opened.data.reference, chargeReference);
  assert.match(opened.data.disputeId, /^mock_dsp_/);
  assert.equal(opened.data.status, 'open');
  assert.equal(opened.data.amountMinor, '1000000');
  assert.equal(opened.data.respondBy, respondBy.toISOString());
  // The pretend partner reports the flat fee the real one charges ($15), so the booking is testable.
  assert.equal(opened.data.feeMinor, '1500');
  assert.equal(opened.data.feeCurrency, 'USD');
  const disputeId = opened.data.disputeId;

  // Signed like every pretend webhook, and accepted by the mock's own check.
  const received = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      received.push(mock.verifyWebhook(Buffer.from(raw), request.headers));
      response.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  await runScenario({
    plan: [{ body: opened, signed: true, delayMs: 0 }],
    webhookUrl: `http://127.0.0.1:${port}/`,
    secret,
  });
  assert.equal(received[0].ok, true);
  assert.equal(received[0].event.type, 'dispute.created');

  assert.deepEqual(await mock.listDisputes(since), [
    {
      partnerDisputeId: disputeId,
      status: 'open',
      amountMinor: 1000000n,
      currency: 'NGN',
      chargeReference,
    },
  ]);
  assert.deepEqual(await mock.listDisputes(new Date(Date.now() + 60_000)), []);

  const { fileRef } = await mock.uploadDisputeFile({
    partnerDisputeId: disputeId,
    bytes: Buffer.from('%PDF'),
    contentType: 'application/pdf',
  });
  assert.match(fileRef, /^mock_upl_/);
  const evidence = {
    partnerDisputeId: disputeId,
    text: 'Receipt attached.',
    fileRefs: [fileRef],
    idempotencyKey: randomUUID(),
  };
  assert.deepEqual(await mock.submitDisputeEvidence(evidence), {
    state: 'submitted',
  });
  // The same key again is the same submission; a new key after submitting is refused.
  assert.deepEqual(await mock.submitDisputeEvidence(evidence), {
    state: 'submitted',
  });
  await assert.rejects(
    mock.submitDisputeEvidence({ ...evidence, idempotencyKey: randomUUID() }),
    DisputeEvidenceRefusedError,
  );
  assert.equal((await mock.listDisputes(since))[0].status, 'responded');

  const lost = await mock.decideDispute(disputeId, 'lost');
  assert.equal(lost.type, 'dispute.updated');
  assert.equal(lost.data.status, 'lost');
  assert.equal(lost.data.disputeId, disputeId);
  assert.equal((await mock.listDisputes(since))[0].status, 'lost');
  // A decided dispute is final.
  await assert.rejects(mock.decideDispute(disputeId, 'won'));
  await assert.rejects(mock.decideDispute('mock_dsp_nope', 'won'));
});
