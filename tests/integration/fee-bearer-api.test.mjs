import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { OpsActionsController } from '../../apps/api/dist/ops/actions.controller.js';
import {
  beginPaymentAccountCreation,
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  reconcileAttempts,
  recordProviderEvent,
  runIssueDetectors,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { ADA } from '../../packages/database/test/integration/helpers.mjs';

// Bachs took the money but never said who paid its processing fee, so the tip stays confirming.
// Staff who see in Bachs' dashboard that the platform paid it can confirm the tip: TipMe reads
// the payment back and books it only if everything else matches the quote.

const staffUserId = '00000000-0000-7000-8000-00000000a0a1';
const logger = { info() {}, warn() {}, error() {} };
const REFERENCE = 'acct_ada123:chk_collected';

async function collectedTip(t, { collected = true } = {}) {
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
    tipMinor: 500000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await markAttemptInitiated(db, {
    attemptId,
    provider: 'bachs',
    providerReference: REFERENCE,
  });
  // Bachs' webhook, as on staging: the payment is pending.
  await recordProviderEvent(db, {
    provider: 'bachs',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.pending',
    attemptId,
    providerReference: REFERENCE,
    signatureVerified: true,
    payload: {},
  });
  if (collected)
    await reconcileAttempts({
      db,
      provider: {
        verifyTransaction: async () => ({
          status: 'pending',
          amountMinor: 500000n,
          currency: 'NGN',
          feeMinor: 7500n,
          collected: true,
        }),
      },
      now: new Date(),
      minAgeMs: 0,
      attemptId,
    });
  await runIssueDetectors(db, new Date(Date.now() + 31 * 60_000));
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const [issue] = await q(
    `SELECT id FROM issues WHERE kind = 'stuck_tip' AND subject->>'tipId' = $1`,
    [tipId],
  );
  assert.ok(issue, 'a stuck-tip issue');
  const tipStatus = async () =>
    (await q(`SELECT status FROM tips WHERE id = $1`, [tipId]))[0].status;
  return { db, q, issueId: issue.id, tipStatus };
}

/** Bachs' answer for the collected payment, with the fee bearer and TipMe fee as given. */
const bachs = ({ feePaidBy = 'unknown', platformFeeMinor = 50000n } = {}) => ({
  asked: 0,
  async verifyTransaction(reference, expectation) {
    this.asked += 1;
    assert.equal(reference, REFERENCE);
    // ₦5,000 tip: TipMe's whole share is ₦500 (₦425 platform + ₦75 processing).
    assert.deepEqual(expectation, { platformFeeMinor: 50000n });
    return {
      status: feePaidBy === 'platform' ? 'succeeded' : 'pending',
      amountMinor: 500000n,
      currency: 'NGN',
      feeMinor: 7500n,
      feePaidBy,
      platformFeeMinor,
      ...(feePaidBy === 'platform' && platformFeeMinor === 50000n
        ? {}
        : { collected: true }),
    };
  },
});

const confirm = (db, provider, issueId) =>
  new OpsActionsController(
    { db },
    { revalidate() {} },
    {},
    provider,
    logger,
  ).confirmBachsFeeBearer(
    { userId: staffUserId },
    {
      issueId,
      feePaidBy: 'platform',
      dashboardVerified: true,
      reason: 'Bachs dashboard shows the platform paid the processing fee',
    },
  );

test('staff confirm a collected tip once Bachs shows the platform paid the fee', async (t) => {
  const { db, q, issueId, tipStatus } = await collectedTip(t);
  const result = await confirm(db, bachs(), issueId);
  assert.equal(result.data.outcome, 'confirmed');
  assert.equal(await tipStatus(), 'SUCCEEDED');
  const [audit] = await q(
    `SELECT action, reason FROM audit_events WHERE action = 'payment_attempt.fee_bearer_confirmed'`,
  );
  assert.ok(audit, 'the confirmation is audited');
  // Confirming again changes nothing.
  assert.equal(
    (await confirm(db, bachs(), issueId)).data.outcome,
    'not_pending',
  );
});

test('a different TipMe fee at Bachs is refused, and the tip stays confirming', async (t) => {
  const { db, issueId, tipStatus } = await collectedTip(t);
  const result = await confirm(
    db,
    bachs({ platformFeeMinor: 40000n }),
    issueId,
  );
  assert.equal(result.data.outcome, 'mismatch');
  assert.equal(await tipStatus(), 'PENDING_VERIFICATION');
});

test('if Bachs says the recipient bore the fee, staff cannot override it', async (t) => {
  const { db, issueId, tipStatus } = await collectedTip(t);
  const result = await confirm(
    db,
    bachs({ feePaidBy: 'connected_account' }),
    issueId,
  );
  assert.equal(result.data.outcome, 'recipient_bore_fee');
  assert.notEqual(await tipStatus(), 'SUCCEEDED');
});

test('a tip whose money was never seen collected cannot be confirmed this way', async (t) => {
  const { db, issueId, tipStatus } = await collectedTip(t, {
    collected: false,
  });
  const provider = bachs();
  const result = await confirm(db, provider, issueId);
  assert.equal(result.data.outcome, 'not_collected');
  assert.equal(provider.asked, 0);
  assert.notEqual(await tipStatus(), 'SUCCEEDED');
});
