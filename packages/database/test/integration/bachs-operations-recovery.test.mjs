import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  attachUnknownBachsCheckoutForOperations,
  autoResolveIssues,
  beginPaymentAccountCreation,
  claimAttemptStart,
  createPaymentIntent,
  createQuote,
  getBachsAccountRecoveryTarget,
  getUnknownBachsAttemptForOperations,
  issueById,
  markAttemptUnknown,
  markPaymentAccountCreationUnknown,
  recoverUnknownPaymentAccount,
  recordProviderEvent,
  runIssueDetectors,
  updatePaymentAccountStatus,
} from '../../dist/index.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

async function createAttempt(db, handle) {
  const { quoteId } = await createQuote(db, {
    handle,
    tipMinor: 100000n,
    currency: 'NGN',
  });
  return createPaymentIntent(db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
}

test('checkout recovery only links a dashboard-verified unknown attempt and final evidence resolves its issue', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await beginPaymentAccountCreation(database.db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(database.db, {
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

  const { attemptId } = await createAttempt(database.db, 'ada');
  await claimAttemptStart(database.db, { attemptId, provider: 'bachs' });
  await markAttemptUnknown(database.db, { attemptId, provider: 'bachs' });

  const now = new Date(Date.now() + 31 * 60_000);
  assert.equal((await runIssueDetectors(database.db, now)).opened, 1);
  const issueResult = await database.pool.query(
    `SELECT id FROM issues WHERE kind = 'payment_attempt_unresolved' AND subject->>'attemptId' = $1`,
    [attemptId],
  );
  const issueId = issueResult.rows[0]?.id;
  assert.ok(issueId);

  const target = await getUnknownBachsAttemptForOperations(
    database.db,
    attemptId,
  );
  assert.ok(target);
  assert.equal(target.accountReference, 'acct_ada123');
  assert.equal(
    await attachUnknownBachsCheckoutForOperations(database.db, {
      issueId,
      attemptId,
      providerReference: 'acct_ada123:chk_test123',
      accountReference: target.accountReference,
      amountMinor: target.amountMinor + 1n,
      currency: target.currency,
      staffUserId: '00000000-0000-7000-8000-00000000a0a1',
      reason: 'Dashboard record amount mismatch',
    }),
    false,
  );

  assert.equal(
    await attachUnknownBachsCheckoutForOperations(database.db, {
      issueId,
      attemptId,
      providerReference: 'acct_ada123:chk_test123',
      accountReference: target.accountReference,
      amountMinor: target.amountMinor,
      currency: target.currency,
      staffUserId: '00000000-0000-7000-8000-00000000a0a1',
      reason: 'Dashboard record amount and currency matched',
      now,
    }),
    true,
  );
  const verified = await recordProviderEvent(database.db, {
    provider: 'bachs',
    providerEventId: 'ops.recovery.test.checkout',
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: 'acct_ada123:chk_test123',
    amountMinor: target.amountMinor,
    currency: target.currency,
    providerFeeMinor: 0n,
    signatureVerified: true,
    payload: { source: 'staff_checkout_recovery' },
    now,
  });
  assert.equal(verified.attemptStatus, 'VERIFIED_SUCCEEDED');
  assert.equal((await autoResolveIssues(database.db, now)).resolved, 1);
  assert.equal((await issueById(database.db, issueId))?.status, 'resolved');
});

test('account recovery requires a verified email, fetches no status itself, and resolves atomically', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await database.pool.query(
    `UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`,
    ['sandbox-recipient@example.test', '00000000-0000-7000-8000-000000007b11'],
  );
  await beginPaymentAccountCreation(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await markPaymentAccountCreationUnknown(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
  });
  const now = new Date();
  assert.equal((await runIssueDetectors(database.db, now)).opened, 1);
  const issueResult = await database.pool.query(
    `SELECT id FROM issues WHERE kind = 'payment_account_unresolved' AND subject->>'profileId' = $1`,
    [TOBI],
  );
  const issueId = issueResult.rows[0]?.id;
  assert.ok(issueId);
  assert.deepEqual(await getBachsAccountRecoveryTarget(database.db, TOBI), {
    status: 'UNKNOWN',
    providerAccountReference: null,
    emailVerified: true,
  });

  await database.pool.query(
    `UPDATE users SET email_verified_at = NULL WHERE id = $1`,
    ['00000000-0000-7000-8000-000000007b11'],
  );
  await assert.rejects(
    recoverUnknownPaymentAccount(database.db, {
      issueId,
      profileId: TOBI,
      providerAccountReference: 'acct_tobi123',
      status: 'ACTIVE',
      chargesEnabled: true,
      feeCollector: 'platform',
      requirementsDue: [],
      dashboardVerified: true,
      staffUserId: '00000000-0000-7000-8000-00000000a0a1',
      reason: 'Dashboard identity and fee settings confirmed',
      now,
    }),
    (error) => error.code === 'EMAIL_VERIFICATION_REQUIRED',
  );
  await database.pool.query(
    `UPDATE users SET email_verified_at = now() WHERE id = $1`,
    ['00000000-0000-7000-8000-000000007b11'],
  );

  const recovered = await recoverUnknownPaymentAccount(database.db, {
    issueId,
    profileId: TOBI,
    providerAccountReference: 'acct_tobi123',
    status: 'ACTIVE',
    chargesEnabled: true,
    feeCollector: 'platform',
    requirementsDue: [],
    dashboardVerified: true,
    staffUserId: '00000000-0000-7000-8000-00000000a0a1',
    reason: 'Dashboard identity and fee settings confirmed',
    now,
  });
  assert.equal(recovered.providerAccountReference, 'acct_tobi123');
  assert.equal(recovered.payoutsEnabled, false);
  assert.equal((await issueById(database.db, issueId))?.status, 'resolved');
  assert.equal(
    (
      await database.pool.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE subject_id = $1 AND action = 'issue.resolved'`,
        [issueId],
      )
    ).rows[0]?.n,
    1,
  );
  assert.equal(
    (
      await database.pool.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment_account.recovered' AND subject_type = 'payment_account'`,
      )
    ).rows[0]?.n,
    1,
  );
});
