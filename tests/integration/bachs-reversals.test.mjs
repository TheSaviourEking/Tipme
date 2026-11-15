import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  beginPaymentAccountCreation,
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  openIssueFromEvent,
  recordProviderEvent,
  resolveIssue,
  seedDemoProfiles,
  updatePaymentAccountStatus,
  withdrawalQuote,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';
import { setSwitch } from './helpers.mjs';

// Refunds and disputes are not modelled yet (ADR-0004 live blocker). Until they are, each one
// Bachs reports raises a money issue for staff and never changes a balance.

const REFERENCE = 'acct_ada123:chk_paid';

test('a Bachs refund or dispute on a paid tip opens one money issue and books nothing', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const { db } = database;
  await beginPaymentAccountCreation(db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(db, {
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
  const quote = await createQuote(db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await markAttemptInitiated(db, {
    attemptId,
    provider: 'bachs',
    providerReference: REFERENCE,
  });
  await recordProviderEvent(db, {
    provider: 'bachs',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: REFERENCE,
    amountMinor: 200000n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: {},
  });
  const ledgerRows = async () =>
    (await database.pool.query('SELECT count(*)::int AS n FROM ledger_entries'))
      .rows[0].n;
  const before = await ledgerRows();

  const webhooks = new WebhookService({ db });
  const reversal = {
    kind: 'reversal',
    eventId: 'evt_refund_1',
    eventType: 'refund.created',
    accountReference: 'acct_ada123',
    providerReference: REFERENCE,
    operationReference: attemptId,
  };
  assert.equal(
    await webhooks.applyBachs(reversal, { environment: 'sandbox' }),
    'reversal_flagged',
  );
  // Redelivery: still one alert.
  assert.equal(
    await webhooks.applyBachs(reversal, { environment: 'sandbox' }),
    'reversal_flagged',
  );
  assert.equal(await ledgerRows(), before);

  const alerts = (
    await database.pool.query(
      `SELECT event_type, dedupe_key, payload FROM outbox_events WHERE event_type = 'payment.reversed'`,
    )
  ).rows;
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].payload, {
    attemptId,
    eventType: 'refund.created',
  });
  assert.equal(
    await openIssueFromEvent(db, {
      eventType: alerts[0].event_type,
      dedupeKey: alerts[0].dedupe_key,
      payload: alerts[0].payload,
    }),
    // The webhook opened it already, to tie the hold to it; the alert finds the same one.
    'duplicate',
  );
  const issue = (
    await database.pool.query(
      `SELECT kind, severity FROM issues WHERE kind = 'payment_reversed'`,
    )
  ).rows;
  assert.deepEqual(issue, [{ kind: 'payment_reversed', severity: 'money' }]);
});

test('a reversal opens its issue and pauses that recipient’s withdrawals', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const { db } = database;
  await beginPaymentAccountCreation(db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(db, {
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
  const quote = await createQuote(db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await markAttemptInitiated(db, {
    attemptId,
    provider: 'bachs',
    providerReference: REFERENCE,
  });
  const reversal = {
    kind: 'reversal',
    eventId: 'evt_refund_hold',
    eventType: 'refund.created',
    accountReference: 'acct_ada123',
    providerReference: REFERENCE,
    operationReference: attemptId,
  };
  const webhooks = new WebhookService({ db });
  await webhooks.applyBachs(reversal, { environment: 'sandbox' });
  const holds = () =>
    database.pool
      .query(
        'SELECT reason, profile_id, issue_id, released_at FROM withdrawal_holds',
      )
      .then((r) => r.rows);
  const [hold] = await holds();
  assert.equal(hold.reason, 'reversal');
  assert.equal(hold.profile_id, ADA);
  const provider = {
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: true },
  };
  assert.deepEqual(await withdrawalQuote(db, { profileId: ADA, provider }), {
    state: 'paused',
    reason: 'reversal',
  });

  // Redelivered: still one hold. Redelivered after staff closed it: no hold comes back.
  await webhooks.applyBachs(reversal, { environment: 'sandbox' });
  assert.equal((await holds()).length, 1);
  await resolveIssue(db, {
    issueId: hold.issue_id,
    staffUserId: randomUUID(),
    reason: 'The provider settled the refund itself.',
    outcome: 'resolved_by_provider',
  });
  await webhooks.applyBachs(reversal, { environment: 'sandbox' });
  const after = await holds();
  assert.equal(after.length, 1);
  assert.ok(after[0].released_at);
});

// Owner, 12 and 14 Nov 2026: with the `refund_fee_return` admin switch on, a final refund is
// recorded in the ledger at once; off (the default), it waits for staff (two people). The switch
// replaced the REFUND_FEE_RETURN variable: nothing in the environment turns it on.
test('a final refund is reversed at refund.paid only while the refund_fee_return switch is on', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const { db } = database;
  await beginPaymentAccountCreation(db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(db, {
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
  const paidTip = async (reference) => {
    const quote = await createQuote(db, {
      handle: 'ada',
      tipMinor: 200000n,
      currency: 'NGN',
    });
    const { attemptId, tipId } = await createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    await markAttemptInitiated(db, {
      attemptId,
      provider: 'bachs',
      providerReference: reference,
    });
    await recordProviderEvent(db, {
      provider: 'bachs',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId,
      providerReference: reference,
      amountMinor: 200000n,
      currency: 'NGN',
      providerFeeMinor: 1500n,
      signatureVerified: true,
      payload: {},
    });
    return { attemptId, tipId };
  };
  const refundPaid = (reference, attemptId) => ({
    kind: 'reversal',
    eventId: `evt_${randomUUID()}`,
    eventType: 'refund.paid',
    accountReference: 'acct_ada123',
    providerReference: reference,
    operationReference: attemptId,
    partnerReversalId: `refund.re_${randomUUID().replaceAll('-', '')}`,
    disputeWon: false,
    refundState: 'paid',
    refundedMinor: 100000n,
    refundFeeMinor: 0n,
  });
  const reversals = async (tipId) =>
    (
      await database.pool.query(
        `SELECT count(*)::int AS n FROM ledger_transactions
          WHERE tip_id = $1 AND operation_type = 'reversal'`,
        [tipId],
      )
    ).rows[0].n;
  const webhooks = new WebhookService({ db });

  // Off (the default): the refund opens its issue and waits for staff.
  const off = await paidTip('acct_ada123:chk_off');
  assert.equal(
    await webhooks.applyBachs(
      refundPaid('acct_ada123:chk_off', off.attemptId),
      {
        environment: 'sandbox',
      },
    ),
    'reversal_flagged',
  );
  assert.equal(await reversals(off.tipId), 0);

  // On: the same final refund is reversed in the ledger at once.
  await setSwitch(database.pool, 'refund_fee_return', true);
  const on = await paidTip('acct_ada123:chk_on');
  assert.equal(
    await webhooks.applyBachs(refundPaid('acct_ada123:chk_on', on.attemptId), {
      environment: 'sandbox',
    }),
    'reversal_flagged',
  );
  assert.equal(await reversals(on.tipId), 1);
  await setSwitch(database.pool, 'refund_fee_return', false);
});
