import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  balanceOf,
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordProviderEvent,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { createMockProvider } from '../../packages/payments/dist/index.js';
import { PAYOUT_PROVIDERS_TOKEN } from '../../apps/api/dist/checkout/payment-provider.provider.js';
import {
  REDIS_URL,
  Redis,
  uniquePrefix,
  WEB,
  browserHeaders,
  signIn,
  startStack,
} from './helpers.mjs';

// Per-provider balances, Task 5: the quote across the active `mock` and the test-only withdraw-only
// `mock_alt`. Users see amounts and states only, never a provider's name.

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const TOBI = DEMO_PROFILES[1];
let database;
let stack;
let redis;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  const roles = { PAYMENT_WITHDRAW_ONLY_PROVIDERS: 'mock_alt' };
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000', ...roles },
    workerEnv: roles,
  });
  redis = new Redis(REDIS_URL);
});
after(async () => {
  await redis.quit();
  await stack.stop();
  await database.close();
});

/** One ₦4,000 tip to `handle` collected through `provider`, recorded as its webhook would. */
async function tip(provider, handle = 'tobi') {
  const { db } = database;
  const quote = await createQuote(db, {
    handle,
    tipMinor: 400000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `${provider}_pay_${randomUUID()}`;
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider,
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider,
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 400000n,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
}

test('one quote across both providers, with no provider named', async () => {
  await tip('mock_alt');
  await tip('mock');
  const ledger = (await balanceOf(database.db, TOBI.id)).availableMinor;
  const each = ledger / 2n;
  // The old provider holds exactly its own tip's net; the active one is the pretend figure.
  await createMockProvider({
    redis,
    prefix: stack.prefix,
    name: 'mock_alt',
  }).markPayoutBalance(TOBI.id, each);
  const { cookie } = await signIn(stack.api, TOBI.phone);
  const response = await fetch(`${stack.api}/v1/me/withdrawal-quote`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const quote = JSON.parse(body).data;
  assert.equal(quote.state, 'ready');
  assert.deepEqual(quote.capsMinor, [each.toString(), each.toString()]);
  assert.equal(quote.withdrawableMinor, ledger.toString());
  assert.equal(quote.partial, false);
  assert.equal(quote.bankDetailsNeeded, false);
  assert.equal(quote.heldElsewhere, false);
  assert.doesNotMatch(body, /mock_alt/);
  assert.doesNotMatch(body, /mock/);

  // The dashboard's question before an amount is typed: a configured provider took the tips.
  const summary = (
    await (
      await fetch(`${stack.api}/v1/me/dashboard`, { headers: { cookie } })
    ).json()
  ).data;
  assert.equal(summary.withdrawalsAvailable, true);
});

test('one request paid as two parts, with amounts only and no provider named', async () => {
  // The tips from the test above: each provider holds exactly its own tip's net.
  const ledger = (await balanceOf(database.db, TOBI.id)).availableMinor;
  const each = ledger / 2n;
  for (const name of ['mock', 'mock_alt'])
    await createMockProvider({
      redis,
      prefix: stack.prefix,
      name,
    }).markPayoutBalance(TOBI.id, each);
  const { cookie } = await signIn(stack.api, TOBI.phone);
  const key = randomUUID();
  const amount = each + 200000n;
  const withdraw = () =>
    fetch(`${stack.api}/v1/me/withdrawals`, {
      method: 'POST',
      headers: browserHeaders(cookie, { 'idempotency-key': key }),
      body: JSON.stringify({ amountMinor: amount.toString() }),
    });
  const response = await withdraw();
  assert.equal(response.status, 201);
  const text = await response.text();
  assert.doesNotMatch(text, /mock/);
  const result = JSON.parse(text).data;
  assert.match(result.groupId, /^[0-9a-f-]{36}$/);
  assert.equal(result.status, 'REQUESTED');
  // The person pays one ₦50 fee for the request, off the largest part (owner, 25 Nov 2026); TipMe
  // pays the other part's.
  const fee = 5000n;
  assert.deepEqual(
    result.parts.map((part) => part.amountMinor),
    [(each - fee).toString(), '200000'],
  );
  assert.equal(result.payoutId, result.parts[0].payoutId);
  // A retry of the same key returns the same group.
  const again = (await (await withdraw()).json()).data;
  assert.equal(again.groupId, result.groupId);
  assert.deepEqual(
    again.parts.map((part) => part.payoutId),
    result.parts.map((part) => part.payoutId),
  );
  // The list shows one row for the request, its total and its parts.
  const listed = await fetch(`${stack.api}/v1/me/withdrawals`, {
    headers: { cookie },
  });
  const listText = await listed.text();
  assert.doesNotMatch(listText, /mock/);
  const rows = JSON.parse(listText).data.items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payoutId, result.payoutId);
  // What is sent: the amount chosen less the one fee.
  assert.equal(rows[0].amountMinor, (amount - fee).toString());
  assert.deepEqual(
    rows[0].parts.map((part) => part.amountMinor),
    [(each - fee).toString(), '200000'],
  );
});

// Task 8 (spec §6 "Bank details across providers"): a bank change is registered at every provider
// in the owner's set. The active one decides the answer; a refusal anywhere else leaves only that
// provider's part needing action. A local connected-account stand-in joins the configured set
// (only one Bachs exists per copy, and none may be reached from a test); Ada holds an account there.

const ADA = DEMO_PROFILES[0];
const STAND_IN_ACCOUNT = 'acct_ada_stand_in';
const STAND_IN_MINOR = 200000n;

/** A connected-account provider that answers locally; `refuse` makes its next adds fail. */
function connectedStandIn() {
  const state = { refuse: false, adds: [] };
  const provider = {
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: true },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance() {
      return { availableMinor: STAND_IN_MINOR };
    },
    async quotePayoutFee() {
      return { feeMinor: 5000n, exact: true };
    },
    async addPayoutDestination(reference, input) {
      state.adds.push({ reference, bankCode: input.bankCode });
      if (state.refuse) {
        const error = new Error('refused');
        error.name = 'BachsApiError';
        throw error;
      }
      return {
        destinationRef: `dest_${reference}_${input.bankCode}_${input.accountNumber.slice(-4)}`,
        usable: true,
        status: 'usable',
      };
    },
    async payoutDestinationStatus() {
      return 'usable';
    },
  };
  return { provider, state };
}

let standIn;
let ada;
let adaLedger;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const activeBanks = () =>
  q(
    `SELECT provider, bank_code, account_last4 FROM payout_destinations
      WHERE profile_id = $1 AND replaced_at IS NULL ORDER BY provider`,
    [ADA.id],
  );

/** A bank-account code sent to the signed-in person's own address, read from the dev inbox. */
async function codeFor(session) {
  await q(`DELETE FROM email_codes`);
  const inbox = async () =>
    (await (await fetch(`${stack.api}/v1/dev/inbox`)).json()).data.filter(
      (mail) => mail.subject?.toLowerCase().includes('bank account'),
    );
  const seen = new Set((await inbox()).map((mail) => mail.body));
  const asked = await fetch(`${stack.api}/v1/me/payout-destination/code`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
  });
  assert.equal(asked.status, 202);
  for (let i = 0; i < 100; i++) {
    // Only a new mail carrying a code: a change notice from the last change may arrive late.
    const mail = (await inbox()).find(
      (m) => !seen.has(m.body) && /\b\d{6}\b/.test(m.body),
    );
    if (mail) return /\b(\d{6})\b/.exec(mail.body)[1];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no code arrived');
}

const changeBankAs = async (session, bankCode, accountNumber) =>
  fetch(`${stack.api}/v1/me/payout-destination`, {
    method: 'PUT',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({
      bankCode,
      accountNumber,
      accountName: 'ADA OKAFOR',
      emailCode: await codeFor(session),
    }),
  });
const changeBank = (bankCode, accountNumber) =>
  changeBankAs(ada, bankCode, accountNumber);

/** The "your bank changed" security emails queued for a person so far. */
const changeMails = async (profile) =>
  (
    await q(
      `SELECT count(*)::int AS n FROM mail_messages
        WHERE type = 'payout_destination_changed' AND user_id = $1`,
      [profile.userId],
    )
  )[0].n;

const adaQuote = async () =>
  (
    await (
      await fetch(`${stack.api}/v1/me/withdrawal-quote`, {
        headers: { cookie: ada.cookie },
      })
    ).json()
  ).data;

test("changing bank registers it at every connected provider in the owner's set", async () => {
  standIn = connectedStandIn();
  stack.app.get(PAYOUT_PROVIDERS_TOKEN).withdrawOnly.push(standIn.provider);
  await q(
    'UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2',
    [`ada@${uniquePrefix()}.example`, ADA.userId],
  );
  await q(
    `INSERT INTO payment_accounts (id, profile_id, provider, environment, provider_account_reference,
       status, charges_enabled, payouts_enabled, manual_payouts_at)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, now())`,
    [randomUUID(), ADA.id, STAND_IN_ACCOUNT],
  );
  await tip('mock', 'ada');
  adaLedger = (await balanceOf(database.db, ADA.id)).availableMinor;
  // The active provider holds all but the stand-in's part, so only both together cover the ledger.
  await createMockProvider({ redis, prefix: stack.prefix }).markPayoutBalance(
    ADA.id,
    adaLedger - STAND_IN_MINOR,
  );
  ada = await signIn(stack.api, ADA.phone);

  const response = await changeBank('058', '0123456781');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    status: 'usable',
    bankName: 'Pretend Guaranty Bank',
    last4: '6781',
  });
  assert.deepEqual(await activeBanks(), [
    { provider: 'bachs', bank_code: '058', account_last4: '6781' },
    { provider: 'mock', bank_code: '058', account_last4: '6781' },
  ]);
  assert.deepEqual(standIn.state.adds, [
    { reference: STAND_IN_ACCOUNT, bankCode: '058' },
  ]);
  const quote = await adaQuote();
  assert.equal(quote.state, 'ready');
  assert.equal(quote.withdrawableMinor, adaLedger.toString());
  assert.equal(quote.bankDetailsNeeded, false);
});

test('a provider that refuses the new bank leaves only its part needing action', async () => {
  standIn.state.refuse = true;
  const response = await changeBank('101', '0123456782');
  // The active provider took it, so the change is made; the person is never told a provider's name.
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /bachs|mock/);
  assert.equal(JSON.parse(text).data.last4, '6782');
  assert.deepEqual(await activeBanks(), [
    { provider: 'bachs', bank_code: '058', account_last4: '6781' },
    { provider: 'mock', bank_code: '101', account_last4: '6782' },
  ]);
  // Staff are told which provider refused, without any account detail.
  const failed = stack.logs.filter(
    (entry) => entry.event === 'withdrawal.bank_register_failed',
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].provider, 'bachs');
  assert.equal(failed[0].error, 'BachsApiError');
  assert.doesNotMatch(JSON.stringify(failed), /0123456782|ADA OKAFOR/);
  // The old bank at the stand-in is never paid: that part needs action, and the rest stays.
  const quote = await adaQuote();
  assert.equal(quote.state, 'ready');
  assert.equal(quote.bankDetailsNeeded, true);
  assert.equal(
    quote.withdrawableMinor,
    (adaLedger - STAND_IN_MINOR).toString(),
  );
});

test('re-entering the current bank fixes a part that needed action', async () => {
  standIn.state.refuse = false;
  const mailsBefore = await changeMails(ADA);
  const response = await changeBank('101', '0123456782');
  assert.equal(response.status, 200);
  assert.deepEqual(await activeBanks(), [
    { provider: 'bachs', bank_code: '101', account_last4: '6782' },
    { provider: 'mock', bank_code: '101', account_last4: '6782' },
  ]);
  const quote = await adaQuote();
  assert.equal(quote.bankDetailsNeeded, false);
  assert.equal(quote.withdrawableMinor, adaLedger.toString());
  // Only the stand-in's row moved: one security email.
  assert.equal((await changeMails(ADA)) - mailsBefore, 1);
});

test('one bank change sends one security email, however many providers it changes', async () => {
  const before = await changeMails(ADA);
  const response = await changeBank('058', '0123456783');
  assert.equal(response.status, 200);
  assert.deepEqual(await activeBanks(), [
    { provider: 'bachs', bank_code: '058', account_last4: '6783' },
    { provider: 'mock', bank_code: '058', account_last4: '6783' },
  ]);
  assert.equal((await changeMails(ADA)) - before, 1);
});

test('an accountless provider holding an old bank row gets the new bank too', async () => {
  // Tobi's money at the withdraw-only pretend provider (the tests above), and a bank row left there
  // from when it was active: a different bank, so its part needs action until the bank is re-added.
  await q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code,
       bank_name, account_last4, status)
     VALUES ($1, $2, 'mock_alt', 'mock_dest_old', '058', 'Pretend Guaranty Bank', '1111', 'usable')`,
    [randomUUID(), TOBI.id],
  );
  await q(
    'UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2',
    [`tobi@${uniquePrefix()}.example`, TOBI.userId],
  );
  const tobi = await signIn(stack.api, TOBI.phone);
  const response = await changeBankAs(tobi, '101', '0123456799');
  assert.equal(response.status, 200);
  const rows = await q(
    `SELECT provider, bank_code, account_last4, destination_reference FROM payout_destinations
      WHERE profile_id = $1 AND replaced_at IS NULL ORDER BY provider`,
    [TOBI.id],
  );
  assert.deepEqual(
    rows.map((row) => [row.provider, row.bank_code, row.account_last4]),
    [
      ['mock', '101', '6799'],
      ['mock_alt', '101', '6799'],
    ],
  );
  // The owner stands in for the account, as for the active pretend provider.
  assert.match(
    rows[1].destination_reference,
    new RegExp(`^mock_dest_${TOBI.id}_`),
  );
});

test('a refusal at the active provider fails the request and asks no other provider', async () => {
  const { registerBankEverywhere } =
    await import('../../apps/api/dist/profiles/register-bank-everywhere.js');
  const other = connectedStandIn();
  const active = {
    name: 'mock',
    capabilities: { connectedAccounts: false },
    async addPayoutDestination() {
      throw new Error('refused');
    },
    async payoutDestinationStatus() {
      return 'usable';
    },
  };
  const saved = [];
  await assert.rejects(
    registerBankEverywhere({
      db: database.db,
      owner: { profileId: ADA.id },
      providers: [active, other.provider],
      accountRefFor: async () => STAND_IN_ACCOUNT,
      bank: {
        accountNumber: '0123456784',
        accountName: 'ADA OKAFOR',
        bankCode: '058',
        bankName: 'Pretend Guaranty Bank',
      },
      callActive: (_step, call) => call(),
      onActiveUnread() {},
      log() {},
      save: async (provider) => saved.push(provider.name),
    }),
    /refused/,
  );
  assert.deepEqual(other.state.adds, []);
  assert.deepEqual(saved, []);
});
