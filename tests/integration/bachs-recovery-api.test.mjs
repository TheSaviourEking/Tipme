import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { OpsActionsController } from '../../apps/api/dist/ops/actions.controller.js';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import {
  beginPaymentAccountCreation,
  claimAttemptStart,
  createPaymentIntent,
  createQuote,
  markAttemptUnknown,
  markPaymentAccountCreationUnknown,
  runIssueDetectors,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  ADA,
  TOBI,
} from '../../packages/database/test/integration/helpers.mjs';

const staffUserId = '00000000-0000-7000-8000-00000000a0a1';
const logger = { info() {}, warn() {}, error() {} };

async function databaseFor(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  return database;
}

async function unknownCheckout(database) {
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
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  await claimAttemptStart(database.db, { attemptId, provider: 'bachs' });
  await markAttemptUnknown(database.db, { attemptId, provider: 'bachs' });
  const now = new Date(Date.now() + 31 * 60_000);
  await runIssueDetectors(database.db, now);
  const issue = (
    await database.pool.query(
      `SELECT id FROM issues WHERE kind = 'payment_attempt_unresolved' AND subject->>'attemptId' = $1`,
      [attemptId],
    )
  ).rows[0];
  assert.ok(issue);
  const quote = (
    await database.pool.query(
      `SELECT q.payer_total_minor, q.currency
         FROM payment_attempts a
         JOIN payment_intents i ON i.id = a.intent_id
         JOIN tip_quotes q ON q.id = i.quote_id
        WHERE a.id = $1`,
      [attemptId],
    )
  ).rows[0];
  return { attemptId, issueId: issue.id, quote };
}

function controller(db, bachsProvider) {
  return new OpsActionsController(
    { db },
    { revalidate() {} },
    {},
    bachsProvider,
    logger,
  );
}

test('checkout recovery verifies matching provider evidence before attaching and processing it', async (t) => {
  const database = await databaseFor(t);
  const { attemptId, issueId, quote } = await unknownCheckout(database);
  const bachsProvider = {
    async verifyTransaction(reference, expectation) {
      assert.equal(reference, 'acct_ada123:chk_test123');
      // A ₦1,000 tip: Bachs confirms success only against TipMe's ₦100 share.
      assert.deepEqual(expectation, { platformFeeMinor: 10000n });
      return {
        status: 'succeeded',
        amountMinor: BigInt(quote.payer_total_minor),
        currency: quote.currency,
        feeMinor: 0n,
        feePaidBy: 'platform',
      };
    },
  };
  const result = await controller(
    database.db,
    bachsProvider,
  ).recoverBachsCheckout(
    { userId: staffUserId },
    {
      issueId,
      attemptId,
      checkoutId: 'chk_test123',
      dashboardVerified: true,
      reason: 'Found the checkout and confirmed its account',
    },
  );
  assert.equal(result.data.outcome, 'attached');
  const attempt = (
    await database.pool.query(
      `SELECT status, provider_reference FROM payment_attempts WHERE id = $1`,
      [attemptId],
    )
  ).rows[0];
  assert.equal(attempt.status, 'VERIFIED_SUCCEEDED');
  assert.equal(attempt.provider_reference, 'acct_ada123:chk_test123');
});

test('checkout recovery leaves an unlocated checkout unknown and unlinked', async (t) => {
  const database = await databaseFor(t);
  const { attemptId, issueId } = await unknownCheckout(database);
  const result = await controller(database.db, {
    async verifyTransaction() {
      return {
        status: 'not_found',
        amountMinor: 0n,
        currency: 'NGN',
        feeMinor: 0n,
      };
    },
  }).recoverBachsCheckout(
    { userId: staffUserId },
    {
      issueId,
      attemptId,
      checkoutId: 'chk_missing123',
      dashboardVerified: true,
      reason: 'Checked the dashboard and no matching record exists',
    },
  );
  assert.equal(result.data.outcome, 'not_found');
  const attempt = (
    await database.pool.query(
      `SELECT status, provider_reference FROM payment_attempts WHERE id = $1`,
      [attemptId],
    )
  ).rows[0];
  assert.equal(attempt.status, 'UNKNOWN');
  assert.equal(attempt.provider_reference, null);
});

test('checkout recovery leaves a mismatched provider result unknown and unlinked', async (t) => {
  const database = await databaseFor(t);
  const { attemptId, issueId, quote } = await unknownCheckout(database);
  const result = await controller(database.db, {
    async verifyTransaction() {
      return {
        status: 'succeeded',
        amountMinor: BigInt(quote.payer_total_minor) + 1n,
        currency: quote.currency,
        feeMinor: 0n,
        feePaidBy: 'platform',
      };
    },
  }).recoverBachsCheckout(
    { userId: staffUserId },
    {
      issueId,
      attemptId,
      checkoutId: 'chk_wrongamount',
      dashboardVerified: true,
      reason: 'Dashboard checkout did not match the quoted amount',
    },
  );
  assert.equal(result.data.outcome, 'mismatch');
  const attempt = (
    await database.pool.query(
      `SELECT status, provider_reference FROM payment_attempts WHERE id = $1`,
      [attemptId],
    )
  ).rows[0];
  assert.equal(attempt.status, 'UNKNOWN');
  assert.equal(attempt.provider_reference, null);
});

test('account recovery fetches provider status, links only the verified recipient, and closes the issue', async (t) => {
  const database = await databaseFor(t);
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
  await runIssueDetectors(database.db, new Date());
  const issueId = (
    await database.pool.query(
      `SELECT id FROM issues WHERE kind = 'payment_account_unresolved' AND subject->>'profileId' = $1`,
      [TOBI],
    )
  ).rows[0]?.id;
  assert.ok(issueId);
  let fetchedReference = '';
  const result = await controller(database.db, {
    async getRecipientAccount(reference) {
      fetchedReference = reference;
      return {
        accountReference: reference,
        active: true,
        ngnCardCollectionStatus: 'active',
        feeCollector: 'platform',
        requirementsDue: [],
      };
    },
  }).recoverBachsAccount(
    { userId: staffUserId },
    {
      issueId,
      accountReference: 'acct_tobi123',
      dashboardVerified: true,
      reason: 'Confirmed account belongs to the verified recipient',
    },
  );
  assert.equal(fetchedReference, 'acct_tobi123');
  assert.deepEqual(result.data, { outcome: 'recovered', status: 'ACTIVE' });
  const account = (
    await database.pool.query(
      `SELECT status, provider_account_reference, payouts_enabled
         FROM payment_accounts
        WHERE profile_id = $1 AND provider = 'bachs' AND environment = 'sandbox'`,
      [TOBI],
    )
  ).rows[0];
  assert.equal(account.status, 'ACTIVE');
  assert.equal(account.provider_account_reference, 'acct_tobi123');
  assert.equal(account.payouts_enabled, false);
  const issue = (
    await database.pool.query(`SELECT status FROM issues WHERE id = $1`, [
      issueId,
    ])
  ).rows[0];
  assert.equal(issue.status, 'resolved');
});

test('staff recovery never activates an account whose recipient would bear Bachs fees', async (t) => {
  const database = await databaseFor(t);
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
  await runIssueDetectors(database.db, new Date());
  const issueId = (
    await database.pool.query(
      `SELECT id FROM issues WHERE kind = 'payment_account_unresolved' AND subject->>'profileId' = $1`,
      [TOBI],
    )
  ).rows[0]?.id;
  const result = await controller(database.db, {
    async getRecipientAccount(reference) {
      return {
        accountReference: reference,
        active: true,
        ngnCardCollectionStatus: 'active',
        feeCollector: 'connected_account',
        requirementsDue: [],
      };
    },
  }).recoverBachsAccount(
    { userId: staffUserId },
    {
      issueId,
      accountReference: 'acct_tobi123',
      dashboardVerified: true,
      reason: 'Confirmed account belongs to the verified recipient',
    },
  );
  assert.deepEqual(result.data, { outcome: 'recovered', status: 'RESTRICTED' });
  const account = (
    await database.pool.query(
      `SELECT status, charges_enabled, fee_collector FROM payment_accounts WHERE profile_id = $1`,
      [TOBI],
    )
  ).rows[0];
  assert.deepEqual(account, {
    status: 'RESTRICTED',
    charges_enabled: false,
    fee_collector: 'connected_account',
  });
});

test('refreshing onboarding stores what Bachs reports and blocks recipient-paid fees', async (t) => {
  const database = await databaseFor(t);
  await database.pool.query(
    `UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`,
    ['sandbox-recipient@example.test', '00000000-0000-7000-8000-000000007b11'],
  );
  await beginPaymentAccountCreation(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_tobi123',
    status: 'ONBOARDING',
    chargesEnabled: false,
    payoutsEnabled: false,
    feeCollector: 'unknown',
    requirementsDue: [],
  });
  const accounts = new PaymentAccountsController(
    { PAYMENT_PROVIDER: 'bachs-sandbox', WEB_ORIGIN: 'http://127.0.0.1:3000' },
    { db: database.db },
    {
      async getRecipientAccount(reference) {
        return {
          accountReference: reference,
          active: true,
          ngnCardCollectionStatus: 'active',
          bankTransferStatus: 'active',
          feeCollector: 'connected_account',
          requirementsDue: [],
        };
      },
      async createOnboardingLink() {
        return 'https://connect.bachs.io/onboarding/test';
      },
    },
    logger,
  );
  const result = await accounts.onboard(
    { userId: '00000000-0000-7000-8000-000000007b11' },
    { country: 'NG', entityType: 'individual' },
  );
  assert.equal(result.data.status, 'RESTRICTED');
  const account = (
    await database.pool.query(
      `SELECT status, charges_enabled, fee_collector FROM payment_accounts WHERE profile_id = $1`,
      [TOBI],
    )
  ).rows[0];
  assert.deepEqual(account, {
    status: 'RESTRICTED',
    charges_enabled: false,
    fee_collector: 'connected_account',
  });
});
