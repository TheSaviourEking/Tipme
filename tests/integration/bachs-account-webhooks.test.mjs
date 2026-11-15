import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DependencyUnavailableError } from '../../apps/api/dist/http/api-exception.filter.js';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import { BachsWebhookController } from '../../apps/api/dist/webhooks/bachs-webhook.controller.js';
import { AccountSetupInFlightError } from '../../apps/api/dist/webhooks/retryable.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  beginPaymentAccountCreation,
  mailSealing,
  runIssueDetectors,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { createBachsProvider } from '../../packages/payments/dist/index.js';
import {
  ADA,
  TOBI,
} from '../../packages/database/test/integration/helpers.mjs';

// An account or capability event only triggers a fresh read from Bachs; what Bachs then
// reports decides readiness, so a later restriction stops new checkouts.

async function activeAccount(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
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
  return database;
}

const restricted = {
  environment: 'sandbox',
  async getRecipientAccount(reference) {
    return {
      accountReference: reference,
      active: true,
      ngnCardCollectionStatus: 'restricted',
      bankTransferStatus: 'active',
      feeCollector: 'platform',
      requirementsDue: ['individual.id_number'],
    };
  },
};

const event = (eventId, accountReference = 'acct_ada123') => ({
  kind: 'account',
  eventId,
  eventType: 'capability.updated',
  accountReference,
});

test('a capability event re-reads the account and a restriction stops checkouts, even when repeated', async (t) => {
  const database = await activeAccount(t);
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(event('evt_cap_1'), restricted),
    'account_refreshed',
  );
  assert.equal(
    await webhooks.applyBachs(event('evt_cap_1'), restricted),
    'account_refreshed',
  );
  const account = (
    await database.pool.query(
      `SELECT status, charges_enabled, requirements_due FROM payment_accounts WHERE profile_id = $1`,
      [ADA],
    )
  ).rows[0];
  assert.deepEqual(account, {
    status: 'RESTRICTED',
    charges_enabled: false,
    requirements_due: ['individual.id_number'],
  });
});

test('an event for an account TipMe does not know is kept as unmatched and reads nothing', async (t) => {
  const database = await activeAccount(t);
  let reads = 0;
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(event('evt_cap_2', 'acct_stranger'), {
      environment: 'sandbox',
      async getRecipientAccount() {
        reads += 1;
        throw new Error('must not be called');
      },
    }),
    'unmatched',
  );
  assert.equal(reads, 0);
});

const TOBI_USER = '00000000-0000-7000-8000-000000007b11';

/** A fake of Bachs live: records every request, and nothing reaches https://api.bachs.io. */
function fakeLiveBachs(requests) {
  return async (url, init) => {
    requests.push({ url, init });
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const account = {
      id: 'acct_live_tobi',
      country: 'NG',
      balance_currencies: ['USD', 'NGN'],
      is_active: false,
      capabilities: { ngn_card_collection: { status: 'pending' } },
      responsibilities: { fees: { collector: 'platform' } },
      requirements: { currently_due: ['individual.id_number'] },
    };
    if (url.pathname === '/v1/accounts') return json(account, 201);
    if (url.pathname === '/v1/balance_settings')
      return json({ schedule_by_currency: { NGN: { interval: 'manual' } } });
    if (url.pathname.endsWith('/account-links'))
      return json({ url: 'https://connect.bachs.io/onboarding/live' });
    return json(account);
  };
}

test('a live provider creates accounts recorded as environment live', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  await database.pool.query(
    `UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`,
    ['live-recipient@example.test', TOBI_USER],
  );
  const requests = [];
  const live = createBachsProvider({
    apiKey: 'sk_live_fake_for_tests',
    environment: 'live',
    webhookSecrets: ['l'.repeat(32)],
    fetchImpl: fakeLiveBachs(requests),
  });
  const sealing = mailSealing(Buffer.alloc(32, 7));
  const accounts = new PaymentAccountsController(
    { PAYMENT_PROVIDER: 'bachs-live', WEB_ORIGIN: 'https://usetipme.xyz' },
    { db: database.db },
    live,
    { info() {}, warn() {}, error() {} },
    { revalidate() {} },
    sealing,
  );

  const result = await accounts.onboard(
    { userId: TOBI_USER },
    { country: 'NG', entityType: 'individual' },
  );
  assert.equal(result.data.status, 'ONBOARDING');
  assert.equal(
    result.data.onboardingUrl,
    'https://connect.bachs.io/onboarding/live',
  );
  assert.ok(requests.length >= 2);
  for (const { url, init } of requests) {
    assert.equal(url.origin, 'https://api.bachs.io');
    assert.equal(init.headers.authorization, 'Bearer sk_live_fake_for_tests');
  }
  const rows = (
    await database.pool.query(
      `SELECT provider, environment, provider_account_reference, status
         FROM payment_accounts WHERE profile_id = $1`,
      [TOBI],
    )
  ).rows;
  assert.deepEqual(rows, [
    {
      provider: 'bachs',
      environment: 'live',
      provider_account_reference: 'acct_live_tobi',
      status: 'ONBOARDING',
    },
  ]);
  const status = await accounts.status({ userId: TOBI_USER });
  assert.equal(status.data.enabled, true);
  assert.equal(status.data.environment, 'live');
  assert.equal(status.data.status, 'ONBOARDING');

  // A live account event refreshes the live row; the same event through a sandbox adapter
  // matches nothing and reads nothing.
  const webhooks = new WebhookService({ db: database.db }, sealing);
  assert.equal(
    await webhooks.applyBachs(event('evt_live_1', 'acct_live_tobi'), live),
    'account_refreshed',
  );
  let sandboxReads = 0;
  assert.equal(
    await webhooks.applyBachs(event('evt_live_2', 'acct_live_tobi'), {
      environment: 'sandbox',
      async getRecipientAccount() {
        sandboxReads += 1;
        throw new Error('must not be called');
      },
    }),
    'unmatched',
  );
  assert.equal(sandboxReads, 0);

  // A sandbox copy's account page never shows the live row.
  const sandboxView = await new PaymentAccountsController(
    { PAYMENT_PROVIDER: 'bachs-sandbox', WEB_ORIGIN: 'https://usetipme.xyz' },
    { db: database.db },
    { environment: 'sandbox' },
    { info() {}, warn() {}, error() {} },
    { revalidate() {} },
    sealing,
  ).status({ userId: TOBI_USER });
  assert.equal(sandboxView.data.environment, 'sandbox');
  assert.equal(sandboxView.data.status, null);
});

test('an account page fails closed when the adapter is not the configured environment', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  const controller = new PaymentAccountsController(
    { PAYMENT_PROVIDER: 'bachs-live', WEB_ORIGIN: 'https://usetipme.xyz' },
    { db: database.db },
    { environment: 'sandbox' },
    { info() {}, warn() {}, error() {} },
    { revalidate() {} },
    mailSealing(Buffer.alloc(32, 7)),
  );
  await assert.rejects(
    controller.status({ userId: TOBI_USER }),
    /does not match PAYMENT_PROVIDER/,
  );
});

// Setup in flight: the onboarding request claims the row (CREATING, no reference) and saves the
// partner's reference only after its calls return, while the partner already sends account events.

async function setupInFlight(t, environment = 'sandbox') {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  await beginPaymentAccountCreation(database.db, {
    profileId: ADA,
    provider: 'bachs',
    environment,
  });
  return database;
}

async function unmatchedRows(database) {
  return (
    await database.pool.query(
      `SELECT provider_event_id, reason FROM unmatched_provider_events ORDER BY provider_event_id`,
    )
  ).rows;
}

async function unmatchedIssues(database) {
  await runIssueDetectors(database.db, new Date());
  return (
    await database.pool.query(
      `SELECT id FROM issues WHERE kind = 'unmatched_event'`,
    )
  ).rows.length;
}

test('an account event during account setup asks for a redelivery, then matches once the reference is saved', async (t) => {
  const database = await setupInFlight(t);
  const webhooks = new WebhookService({ db: database.db });
  await assert.rejects(
    webhooks.applyBachs(event('evt_setup_1'), restricted),
    (error) => error instanceof AccountSetupInFlightError,
  );
  assert.deepEqual(await unmatchedRows(database), []);
  assert.equal(await unmatchedIssues(database), 0);

  // The onboarding request finishes and saves the partner's reference; the redelivery matches.
  await updatePaymentAccountStatus(database.db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_ada123',
    status: 'ONBOARDING',
    chargesEnabled: false,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
  assert.equal(
    await webhooks.applyBachs(event('evt_setup_1'), restricted),
    'account_refreshed',
  );
  assert.deepEqual(await unmatchedRows(database), []);
});

test('the webhook endpoint answers 503 for an account event during account setup, so the partner retries', async (t) => {
  const database = await setupInFlight(t);
  const webhooks = new WebhookService({ db: database.db });
  const logs = [];
  const controller = new BachsWebhookController(
    {
      environment: 'sandbox',
      verifyWebhook: () => ({ ok: true, event: event('evt_setup_http') }),
      getRecipientAccount: restricted.getRecipientAccount,
    },
    { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry) },
    webhooks,
  );
  await assert.rejects(
    controller.receive({ rawBody: Buffer.from('{}'), headers: {} }),
    (error) => error instanceof DependencyUnavailableError,
  );
  assert.ok(logs.some((entry) => entry.event === 'webhook.deferred'));
  assert.deepEqual(await unmatchedRows(database), []);
});

test('a setup in the other environment does not hold back an event for an unknown account', async (t) => {
  const database = await setupInFlight(t, 'live');
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(
      event('evt_setup_2', 'acct_stranger'),
      restricted,
    ),
    'unmatched',
  );
});

test('a setup claimed more than ten minutes ago no longer holds events back', async (t) => {
  const database = await setupInFlight(t);
  await database.pool.query(
    `UPDATE payment_accounts SET updated_at = now() - interval '11 minutes' WHERE profile_id = $1`,
    [ADA],
  );
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(event('evt_setup_3'), restricted),
    'unmatched',
  );
  assert.deepEqual(await unmatchedRows(database), [
    { provider_event_id: 'evt_setup_3', reason: 'unknown_account' },
  ]);
  assert.equal(await unmatchedIssues(database), 0);
});

test('an account event for an account TipMe never had is kept for audit but is not a staff issue', async (t) => {
  const database = await activeAccount(t);
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(
      event('evt_foreign_1', 'acct_stranger'),
      restricted,
    ),
    'unmatched',
  );
  assert.deepEqual(await unmatchedRows(database), [
    { provider_event_id: 'evt_foreign_1', reason: 'unknown_account' },
  ]);
  assert.equal(await unmatchedIssues(database), 0);
});

test('an unmatched payment event still raises a staff issue', async (t) => {
  const database = await activeAccount(t);
  const webhooks = new WebhookService({ db: database.db });
  assert.equal(
    await webhooks.applyBachs(
      {
        kind: 'payment',
        eventId: 'evt_pay_unknown',
        eventType: 'charge.succeeded',
        accountReference: 'acct_ada123',
        operationReference: '00000000-0000-7000-8000-00000000dead',
        providerReference: 'ch_unknown',
        status: 'succeeded',
        feePaidBy: 'unknown',
      },
      restricted,
    ),
    'unmatched',
  );
  assert.deepEqual(await unmatchedRows(database), [
    { provider_event_id: 'evt_pay_unknown', reason: 'unknown_attempt' },
  ]);
  assert.equal(await unmatchedIssues(database), 1);
});
