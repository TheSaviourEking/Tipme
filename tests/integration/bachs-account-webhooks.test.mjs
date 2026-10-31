import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import {
  beginPaymentAccountCreation,
  mailSealing,
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
