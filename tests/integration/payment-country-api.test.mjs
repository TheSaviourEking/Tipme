import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import {
  DEMO_PROFILES,
  beginPaymentAccountCreation,
  mailSealing,
  seedDemoProfiles,
  updatePaymentAccountStatus,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Payment account setup takes only our payment partner's payout countries (owner's choice,
// 14 Nov 2026). The return from the hosted setup page sends no country: it only re-checks an
// account that already exists. No request here reaches the partner: the provider is a fake.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [, TOBI] = DEMO_PROFILES;
const sealing = mailSealing(Buffer.alloc(32, 7));
let database;
let stack;
let tobi;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  await database.pool.query(
    `UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`,
    ['country-recipient@example.test', TOBI.userId],
  );
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_INTENTS_PER_MIN: '1000' },
  });
  tobi = (await signIn(stack.api, TOBI.phone)).cookie;
});
after(async () => {
  await stack.stop();
  await database.close();
});

const onboardOverHttp = (body) =>
  fetch(`${stack.api}/v1/me/payment-account/onboarding`, {
    method: 'POST',
    headers: browserHeaders(tobi),
    body: JSON.stringify(body),
  });

async function accountRows() {
  const { rows } = await database.pool.query(
    `SELECT status, provider_account_reference FROM payment_accounts WHERE profile_id = $1`,
    [TOBI.id],
  );
  return rows;
}

for (const country of ['ZZ', 'gh', 'XX']) {
  test(`country "${country}" is refused with 400 COUNTRY_NOT_SUPPORTED`, async () => {
    const response = await onboardOverHttp({
      country,
      entityType: 'individual',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'COUNTRY_NOT_SUPPORTED');
    assert.deepEqual(await accountRows(), []);
  });
}

test('a country that is not a string is a plain validation failure', async () => {
  const response = await onboardOverHttp({
    country: 7,
    entityType: 'individual',
  });
  assert.equal(response.status, 400);
  const { error } = await response.json();
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.deepEqual(error.fields, ['country']);
});

test('a listed country passes validation over HTTP', async () => {
  // This stack runs the pretend provider, so past validation the answer is "no payment account
  // setup here" (404), not a 400.
  const response = await onboardOverHttp({
    country: 'GH',
    entityType: 'individual',
  });
  assert.equal(response.status, 404);
});

/** A fake Bachs sandbox: records calls; nothing reaches api.bachs.io. */
function fakeProvider(calls) {
  const remote = (reference) => ({
    accountReference: reference,
    active: false,
    ngnCardCollectionStatus: 'pending',
    bankTransferStatus: 'pending',
    feeCollector: 'platform',
    requirementsDue: ['individual.id_number'],
    holdsLocalCurrency: true,
  });
  return {
    name: 'bachs-sandbox',
    environment: 'sandbox',
    capabilities: { connectedAccounts: true },
    setManualPayouts: async () => undefined,
    payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
    requestPayoutCapabilities: async () => undefined,
    payoutDestinationStatus: async () => 'usable',
    async createRecipientAccount(input) {
      calls.push(['create', input.country]);
      return remote('acct_country_new');
    },
    async getRecipientAccount(reference) {
      calls.push(['read', reference]);
      return remote(reference);
    },
    async holdLocalCurrency(reference) {
      return remote(reference);
    },
    async createOnboardingLink() {
      calls.push(['link']);
      return 'https://hosted.example/setup';
    },
  };
}

function controller(provider) {
  return new PaymentAccountsController(
    { PAYMENT_PROVIDER: 'bachs-sandbox', WEB_ORIGIN: WEB },
    { db: database.db },
    provider,
    { info() {}, warn() {}, error() {} },
    { revalidate() {} },
    sealing,
  );
}

async function clearAccounts() {
  await database.pool.query(
    `DELETE FROM payment_accounts WHERE profile_id = $1`,
    [TOBI.id],
  );
}

test('a listed country creates the account in that country', async () => {
  await clearAccounts();
  const calls = [];
  const { data } = await controller(fakeProvider(calls)).onboard(
    { userId: TOBI.userId },
    { country: 'GH', entityType: 'individual' },
  );
  assert.deepEqual(calls[0], ['create', 'GH']);
  assert.equal(data.onboardingUrl, 'https://hosted.example/setup');
  await clearAccounts();
});

test('the return from setup re-checks an existing account with no country', async () => {
  await clearAccounts();
  await beginPaymentAccountCreation(database.db, {
    profileId: TOBI.id,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(database.db, {
    sealing,
    profileId: TOBI.id,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_country_old',
    status: 'ONBOARDING',
    chargesEnabled: false,
    payoutsEnabled: false,
    feeCollector: 'unknown',
    requirementsDue: [],
  });
  const calls = [];
  const { data } = await controller(fakeProvider(calls)).onboard(
    { userId: TOBI.userId },
    { entityType: 'individual' },
  );
  assert.deepEqual(calls[0], ['read', 'acct_country_old']);
  assert.equal(data.status, 'ONBOARDING');
  assert.equal(data.onboardingUrl, 'https://hosted.example/setup');
  assert.equal(
    calls.some(([kind]) => kind === 'create'),
    false,
  );
  await clearAccounts();
});

test('with no country and no account, nothing is created', async () => {
  await clearAccounts();
  const calls = [];
  await assert.rejects(
    controller(fakeProvider(calls)).onboard(
      { userId: TOBI.userId },
      { entityType: 'individual' },
    ),
    (error) => error.getStatus?.() === 400,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(await accountRows(), []);
});
