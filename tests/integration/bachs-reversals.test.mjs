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
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';

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
    tipMinor: 100000n,
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
    amountMinor: 100000n,
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
  assert.equal(await webhooks.applyBachs(reversal), 'reversal_flagged');
  // Redelivery: still one alert.
  assert.equal(await webhooks.applyBachs(reversal), 'reversal_flagged');
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
    'opened',
  );
  const issue = (
    await database.pool.query(
      `SELECT kind, severity FROM issues WHERE kind = 'payment_reversed'`,
    )
  ).rows;
  assert.deepEqual(issue, [{ kind: 'payment_reversed', severity: 'money' }]);
});
