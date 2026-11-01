import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import { PayoutDestinationController } from '../../apps/api/dist/profiles/payout-destination.controller.js';
import { RateLimitGuard } from '../../apps/api/dist/checkout/rate-limit.guard.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import * as ops from '../../packages/database/dist/index.js';
import {
  beginPaymentAccountCreation,
  createPaymentIntent,
  createQuote,
  mailSealing,
  markAttemptInitiated,
  recordProviderEvent,
  requestWithdrawal,
  seedDemoProfiles,
  setPayoutDestination,
  startPayout,
  sweepPayoutSetup,
  updatePaymentAccountStatus,
  withdrawalQuote,
} from '../../packages/database/dist/index.js';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import {
  ADA,
  TOBI,
} from '../../packages/database/test/integration/helpers.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { browserHeaders, startStack, uniquePrefix } from './helpers.mjs';

const sealing = mailSealing(Buffer.alloc(32, 7));
const SECRET = 'test-auth-code-secret-at-least-32-chars!';
const TOBI_USER = '00000000-0000-7000-8000-000000007b11';
const EMAIL = 'tobi-bank@example.test';
const ACCOUNT = 'acct_tobi123';
const NUMBER = '0123456789';
const auth = { userId: TOBI_USER };
const config = {
  PAYMENT_PROVIDER: 'bachs-sandbox',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
  AUTH_CODE_SECRET: SECRET,
};

async function setUp(t, { manual = true } = {}) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  await seedDemoProfiles(database.db);
  await database.pool.query(
    `UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`,
    [EMAIL, TOBI_USER],
  );
  await beginPaymentAccountCreation(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await updatePaymentAccountStatus(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: ACCOUNT,
    status: 'ACTIVE',
    chargesEnabled: true,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
  if (manual)
    await database.pool.query(
      `UPDATE payment_accounts SET manual_payouts_at = now(),
         payout_capabilities_requested_at = now()`,
    );
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

/** One ₦10,000 tip collected through the payment provider. */
async function seedPaidTip({ db }) {
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: 1000000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `${ACCOUNT}:chk_${randomUUID().slice(0, 8)}`;
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider: 'bachs',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 1000000n,
    currency: 'NGN',
    providerFeeMinor: 15000n,
    signatureVerified: true,
    payload: {},
  });
}

/** A Bachs stand-in, recording what it was sent. Nothing here can reach a real origin. */
function fakeBachs(overrides = {}) {
  const calls = [];
  const record =
    (name, answer) =>
    async (...args) => {
      calls.push({ name, args });
      return answer(...args);
    };
  return {
    calls,
    named: (name) => calls.filter((call) => call.name === name),
    name: 'bachs-sandbox',
    environment: 'sandbox',
    capabilities: { connectedAccounts: true },
    listBanks: record('listBanks', async () => [
      { code: '058', name: 'Guaranty Trust Bank' },
      { code: '101', name: 'Providus Bank' },
    ]),
    resolveBankAccount: record('resolveBankAccount', async () => ({
      accountName: 'TOBI ADEYEMI',
    })),
    addPayoutDestination: record(
      'addPayoutDestination',
      async (_account, { accountNumber, bankCode }) => ({
        destinationRef: `pd_${bankCode}_${accountNumber.slice(-4)}`,
        usable: true,
        status: 'usable',
      }),
    ),
    payoutDestinationStatus: record(
      'payoutDestinationStatus',
      async () => 'usable',
    ),
    setManualPayouts: record('setManualPayouts', async () => undefined),
    payoutCapability: record('payoutCapability', async () => ({
      status: 'active',
      requirementsDue: [],
    })),
    requestPayoutCapabilities: record(
      'requestPayoutCapabilities',
      async () => undefined,
    ),
    payoutBalance: async () => ({ availableMinor: 10_000_000n }),
    quotePayoutFee: async () => ({ feeMinor: 5000n, exact: false }),
    getRecipientAccount: async (reference) => ({
      accountReference: reference,
      active: true,
      ngnCardCollectionStatus: 'active',
      bankTransferStatus: 'active',
      feeCollector: 'platform',
      requirementsDue: [],
      holdsLocalCurrency: true,
    }),
    ...overrides,
  };
}

function controllerFor(database, provider, logs = []) {
  const logger = {
    info: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  };
  return new PayoutDestinationController(
    config,
    { db: database.db },
    provider,
    logger,
    sealing,
  );
}

async function freshCode(database, controller) {
  await database.pool.query(`DELETE FROM email_codes`);
  await controller.requestCode(auth);
  const mails = await queuedMail(database.db, sealing, { limit: 50 });
  return mails.find((mail) => mail.type === 'payout_destination_code').data
    .code;
}

async function addBank(database, controller, overrides = {}) {
  return controller.update(auth, {
    bankCode: '058',
    accountNumber: NUMBER,
    accountName: 'TOBI ADEYEMI',
    emailCode: await freshCode(database, controller),
    ...overrides,
  });
}

const notices = async (database) =>
  (await queuedMail(database.db, sealing, { limit: 50 })).filter(
    (mail) => mail.type === 'payout_destination_changed',
  );

const manualAt = async ({ rows }) =>
  (await rows(`SELECT manual_payouts_at AS at FROM payment_accounts`))[0].at;

const onboard = (database, provider) =>
  new PaymentAccountsController(
    config,
    { db: database.db },
    provider,
    { info() {}, warn() {}, error() {} },
    { revalidate() {} },
    sealing,
  ).onboard(auth, { country: 'NG', entityType: 'individual' });

test('a new live account is set to manual payouts once', async (t) => {
  const database = await setUp(t, { manual: false });
  const provider = fakeBachs();
  await onboard(database, provider);
  assert.ok(await manualAt(database));
  await onboard(database, provider);
  await new WebhookService({ db: database.db }).applyBachs(
    {
      kind: 'account',
      eventId: 'evt_once',
      eventType: 'account.updated',
      accountReference: ACCOUNT,
    },
    provider,
  );
  await sweepPayoutSetup(database.db, { provider });
  assert.deepEqual(
    provider.named('setManualPayouts').map((call) => call.args),
    [[ACCOUNT]],
  );
});

test('an account event sets manual payouts on an existing account', async (t) => {
  const database = await setUp(t, { manual: false });
  const provider = fakeBachs();
  await new WebhookService({ db: database.db }).applyBachs(
    {
      kind: 'account',
      eventId: 'evt_existing',
      eventType: 'account.updated',
      accountReference: ACCOUNT,
    },
    provider,
  );
  assert.ok(await manualAt(database));
});

test('a provider failure on an account event still refreshes it and leaves it to the sweep', async (t) => {
  const database = await setUp(t, { manual: false });
  const provider = fakeBachs({
    setManualPayouts: async () => {
      throw new Error('provider down');
    },
  });
  assert.equal(
    await new WebhookService({ db: database.db }).applyBachs(
      {
        kind: 'account',
        eventId: 'evt_fail',
        eventType: 'account.updated',
        accountReference: ACCOUNT,
      },
      provider,
    ),
    'account_refreshed',
  );
  assert.equal(await manualAt(database), null);
});

test('the sweep reaches a quiet account; a failure leaves it null and the next run finishes it', async (t) => {
  const database = await setUp(t, { manual: false });
  const failing = fakeBachs({
    setManualPayouts: async () => {
      throw new Error('provider down');
    },
  });
  const first = await sweepPayoutSetup(database.db, { provider: failing });
  assert.equal(first.failed, 1);
  assert.equal(await manualAt(database), null);
  const provider = fakeBachs();
  const second = await sweepPayoutSetup(database.db, { provider });
  assert.equal(second.failed, 0);
  assert.ok(await manualAt(database));
  await sweepPayoutSetup(database.db, { provider });
  assert.equal(provider.named('setManualPayouts').length, 1);
});

test('the sweep asks for payout capabilities only on an account without them', async (t) => {
  const database = await setUp(t, { manual: false });
  const missing = fakeBachs({
    payoutCapability: async () => ({ status: 'missing', requirementsDue: [] }),
  });
  await sweepPayoutSetup(database.db, { provider: missing });
  assert.equal(missing.named('requestPayoutCapabilities').length, 1);
  const [row] = await database.rows(
    `SELECT payout_capabilities_requested_at AS at FROM payment_accounts`,
  );
  assert.ok(row.at);

  const again = fakeBachs();
  await sweepPayoutSetup(database.db, { provider: again });
  assert.equal(again.named('payoutCapability').length, 0);
});

test('a refused capability request is retried, and does not stop manual payouts', async (t) => {
  const database = await setUp(t, { manual: false });
  const provider = fakeBachs({
    payoutCapability: async () => ({ status: 'missing', requirementsDue: [] }),
    requestPayoutCapabilities: async () => {
      throw new Error('refused');
    },
  });
  const swept = await sweepPayoutSetup(database.db, { provider });
  assert.equal(swept.failed, 1);
  assert.ok(await manualAt(database));
  const [row] = await database.rows(
    `SELECT payout_capabilities_requested_at AS at FROM payment_accounts`,
  );
  assert.equal(row.at, null);
});

test('the sweep leaves the other environment alone', async (t) => {
  const database = await setUp(t, { manual: false });
  const provider = fakeBachs({ name: 'bachs-live', environment: 'live' });
  await sweepPayoutSetup(database.db, { provider });
  assert.equal(provider.named('setManualPayouts').length, 0);
  assert.equal(await manualAt(database), null);
});

test('withdrawals wait until manual payouts are set', async (t) => {
  const database = await setUp(t, { manual: false });
  const provider = fakeBachs();
  await setPayoutDestination(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    destinationRef: 'pd_1',
    bankCode: '058',
    bankName: 'Guaranty Trust Bank',
    last4: '6789',
    status: 'usable',
  });
  const quote = await withdrawalQuote(database.db, {
    profileId: TOBI,
    provider,
  });
  assert.deepEqual(quote, { state: 'setup_needed', requirementsDue: [] });
  await assert.rejects(
    requestWithdrawal(database.db, {
      profileId: TOBI,
      amountMinor: 100000n,
      idempotencyKey: randomUUID(),
      provider,
    }),
    { code: 'PAYOUT_SETUP_NEEDED' },
  );
  await sweepPayoutSetup(database.db, { provider });
  const after = await withdrawalQuote(database.db, {
    profileId: TOBI,
    provider,
  });
  assert.equal(after.state, 'ready');
});

test('adding a bank account without a fresh email code is refused', async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs();
  const controller = controllerFor(database, provider);
  const body = {
    bankCode: '058',
    accountNumber: NUMBER,
    accountName: 'TOBI ADEYEMI',
  };
  await assert.rejects(
    controller.update(auth, { ...body, emailCode: '000000' }),
    { status: 400 },
  );

  // A code for changing the email address does not open this door.
  const { requestEmailChangeCode } =
    await import('../../packages/database/dist/index.js');
  await requestEmailChangeCode(database.db, sealing, {
    userId: TOBI_USER,
    email: EMAIL,
    secret: SECRET,
  });
  const changeCode = (
    await queuedMail(database.db, sealing, { limit: 50 })
  ).find((mail) => mail.type === 'email_change_code').data.code;
  await assert.rejects(
    controller.update(auth, { ...body, emailCode: changeCode }),
    { status: 400 },
  );

  // Spent once, a code can't be used again.
  const code = await freshCode(database, controller);
  await controller.update(auth, { ...body, emailCode: code });
  await assert.rejects(
    controller.update(auth, {
      ...body,
      accountNumber: '9999999999',
      emailCode: code,
    }),
    { status: 400 },
  );
  assert.equal(provider.named('addPayoutDestination').length, 1);
});

test('a recipient with no confirmed email cannot ask for a code or add a bank', async (t) => {
  const database = await setUp(t);
  await database.pool.query(
    `UPDATE users SET email_verified_at = NULL WHERE id = $1`,
    [TOBI_USER],
  );
  const controller = controllerFor(database, fakeBachs());
  await assert.rejects(controller.requestCode(auth), { status: 409 });
  await assert.rejects(
    controller.update(auth, {
      bankCode: '058',
      accountNumber: NUMBER,
      accountName: 'TOBI ADEYEMI',
      emailCode: '123456',
    }),
    { status: 409 },
  );
});

test("an account not yet set up can't add a bank, and no code is spent on trying", async (t) => {
  const database = await setUp(t);
  await database.pool.query(`DELETE FROM payment_accounts`);
  const provider = fakeBachs();
  const controller = controllerFor(database, provider);
  const emailCode = await freshCode(database, controller);
  await assert.rejects(
    controller.update(auth, {
      bankCode: '058',
      accountNumber: NUMBER,
      accountName: 'TOBI ADEYEMI',
      emailCode,
    }),
    { status: 409 },
  );
  const [row] = await database.rows(
    `SELECT consumed_at FROM email_codes ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(row.consumed_at, null);
  assert.equal(provider.named('addPayoutDestination').length, 0);
});

test("the bank name comes from the provider's list, and an unknown bank is refused", async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs();
  const controller = controllerFor(database, provider);
  await assert.rejects(addBank(database, controller, { bankCode: '999' }), {
    status: 400,
  });
  const { data } = await addBank(database, controller, { bankCode: '101' });
  assert.deepEqual(data, {
    status: 'usable',
    bankName: 'Providus Bank',
    last4: '6789',
  });
});

test('only the destination reference, bank name and last four digits are stored', async (t) => {
  const database = await setUp(t);
  const logs = [];
  const provider = fakeBachs();
  const controller = controllerFor(database, provider, logs);
  const response = await addBank(database, controller);
  assert.deepEqual(provider.named('addPayoutDestination')[0].args, [
    ACCOUNT,
    { accountNumber: NUMBER, accountName: 'TOBI ADEYEMI', bankCode: '058' },
  ]);
  const [row] = await database.rows(`SELECT * FROM payout_destinations`);
  assert.equal(row.destination_reference, 'pd_058_6789');
  assert.equal(row.bank_name, 'Guaranty Trust Bank');
  assert.equal(row.account_last4, '6789');
  // Every column but the UUIDs, whose digit runs mean nothing.
  const stored = { ...row, id: null, profile_id: null };
  assert.doesNotMatch(
    JSON.stringify({ ...stored, created_at: null }),
    /\d{10}/,
  );
  assert.doesNotMatch(JSON.stringify(row), new RegExp(NUMBER));
  assert.doesNotMatch(JSON.stringify(row), /TOBI ADEYEMI/);
  assert.doesNotMatch(JSON.stringify(response), /\d{10}/);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(NUMBER));
  // Not in anything else committed, such as the audit trail or an outbox payload.
  const [{ dump }] = await database.rows(
    `SELECT string_agg(payload::text, ' ') AS dump FROM outbox_events`,
  );
  assert.doesNotMatch(dump ?? '', new RegExp(NUMBER));
});

test('provider failures log no account data and say nothing of the provider', async (t) => {
  const database = await setUp(t);
  const logs = [];
  const provider = fakeBachs({
    addPayoutDestination: async () => {
      throw new Error(`Bachs refused ${NUMBER}`);
    },
    resolveBankAccount: async () => {
      throw new Error(`Bachs refused ${NUMBER}`);
    },
  });
  const controller = controllerFor(database, provider, logs);
  await assert.rejects(addBank(database, controller), (error) => {
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /bachs/i);
    return error.getStatus() === 503;
  });
  await assert.rejects(
    controller.resolve(auth, { bankCode: '058', accountNumber: NUMBER }),
    { status: 503 },
  );
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(NUMBER));
  assert.equal(
    (await database.rows(`SELECT * FROM payout_destinations`)).length,
    0,
  );
});

test('changing the account sends a security notice; the first one does not', async (t) => {
  const database = await setUp(t);
  const controller = controllerFor(database, fakeBachs());
  await addBank(database, controller);
  assert.equal((await notices(database)).length, 0);

  // Sending the same account again changes nothing.
  await addBank(database, controller);
  assert.equal((await notices(database)).length, 0);

  await addBank(database, controller, { accountNumber: '1111111234' });
  const sent = await notices(database);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].data, {
    bankName: 'Guaranty Trust Bank',
    last4: '1234',
    previousBankName: 'Guaranty Trust Bank',
    previousLast4: '6789',
  });
  const active = await database.rows(
    `SELECT account_last4 FROM payout_destinations WHERE replaced_at IS NULL`,
  );
  assert.deepEqual(active, [{ account_last4: '1234' }]);
  assert.equal(
    (await database.rows(`SELECT id FROM payout_destinations`)).length,
    2,
  );
});

test('two changes at once leave one current account, and one notice per replacement', async (t) => {
  const database = await setUp(t);
  const set = (destinationRef, last4) =>
    setPayoutDestination(database.db, {
      sealing,
      profileId: TOBI,
      provider: 'bachs',
      destinationRef,
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      last4,
      status: 'usable',
    });
  const results = await Promise.all([
    set('pd_a', '1111'),
    set('pd_b', '2222'),
    set('pd_c', '3333'),
  ]);
  assert.deepEqual(results.map((r) => r.replaced).sort(), [false, true, true]);
  assert.equal(
    (
      await database.rows(
        `SELECT id FROM payout_destinations WHERE replaced_at IS NULL`,
      )
    ).length,
    1,
  );
  assert.equal((await notices(database)).length, 2);
});

test('a bank change waits while a withdrawal holds the profile', async (t) => {
  const database = await setUp(t);
  await setPayoutDestination(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    destinationRef: 'pd_old',
    bankCode: '058',
    bankName: 'Guaranty Trust Bank',
    last4: '1111',
    status: 'usable',
  });
  const lock = await database.pool.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM profiles WHERE id = $1 FOR UPDATE', [TOBI]);
  let finished = false;
  const change = setPayoutDestination(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    destinationRef: 'pd_new',
    bankCode: '058',
    bankName: 'Guaranty Trust Bank',
    last4: '2222',
    status: 'usable',
  }).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(finished, false, 'the change must wait for the lock');
  await lock.query('COMMIT');
  lock.release();
  assert.equal((await change).replaced, true);
});

test('a payout in flight keeps the destination it recorded', async (t) => {
  const database = await setUp(t);
  await seedPaidTip(database);
  const provider = fakeBachs();
  const controller = controllerFor(database, provider);
  await addBank(database, controller);
  const { payoutId } = await requestWithdrawal(database.db, {
    profileId: TOBI,
    amountMinor: 200000n,
    idempotencyKey: randomUUID(),
    provider,
  });
  await addBank(database, controller, { accountNumber: '1111111234' });

  const sent = [];
  await startPayout(database.db, {
    payoutId,
    provider: () => ({
      ...provider,
      platformBalance: async () => ({ availableMinor: 10_000_000n }),
      coverPayoutFee: async () => ({ transferRef: 'tr_1' }),
      initiatePayout: async (input) => {
        sent.push(input.destinationRef);
        return { providerReference: `${ACCOUNT}:po_1`, status: 'pending' };
      },
    }),
  });
  assert.deepEqual(sent, ['pd_058_6789']);
  const [row] = await database.rows(
    `SELECT d.destination_reference AS ref, d.replaced_at IS NOT NULL AS replaced
       FROM payouts p JOIN payout_destinations d ON d.id = p.destination_id
      WHERE p.id = $1`,
    [payoutId],
  );
  assert.deepEqual(row, { ref: 'pd_058_6789', replaced: true });
});

test('a rejected destination shows as rejected and can be replaced', async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs({
    addPayoutDestination: async (_account, { accountNumber }) =>
      accountNumber === NUMBER
        ? { destinationRef: 'pd_bad', usable: false, status: 'rejected' }
        : { destinationRef: 'pd_good', usable: true, status: 'usable' },
    payoutDestinationStatus: async (_account, ref) =>
      ref === 'pd_bad' ? 'rejected' : 'usable',
  });
  const controller = controllerFor(database, provider);
  const rejected = await addBank(database, controller);
  assert.equal(rejected.data.status, 'rejected');
  assert.equal(
    (await controller.current(auth)).data.destination.status,
    'rejected',
  );
  assert.equal(
    (await withdrawalQuote(database.db, { profileId: TOBI, provider })).state,
    'no_destination',
  );
  const fixed = await addBank(database, controller, {
    accountNumber: '1111111234',
  });
  assert.equal(fixed.data.status, 'usable');
  assert.equal(
    (await withdrawalQuote(database.db, { profileId: TOBI, provider })).state,
    'ready',
  );
});

test('a replayed answer does not decide: the destination is read back after adding', async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs({
    addPayoutDestination: async () => ({
      destinationRef: 'pd_1',
      usable: false,
      status: 'pending_review',
    }),
    payoutDestinationStatus: async () => 'usable',
  });
  const { data } = await addBank(database, controllerFor(database, provider));
  assert.equal(data.status, 'usable');
});

test('a destination under review becomes usable when the provider says so, by any path', async (t) => {
  const database = await setUp(t);
  let answer = 'pending_review';
  const provider = fakeBachs({
    addPayoutDestination: async () => ({
      destinationRef: 'pd_1',
      usable: false,
      status: 'pending_review',
    }),
    payoutDestinationStatus: async () => answer,
  });
  const controller = controllerFor(database, provider);
  assert.equal(
    (await addBank(database, controller)).data.status,
    'pending_review',
  );
  assert.equal(
    (await withdrawalQuote(database.db, { profileId: TOBI, provider })).state,
    'destination_pending',
  );
  // A failed read changes nothing.
  const down = {
    ...provider,
    payoutDestinationStatus: async () => {
      throw new Error('down');
    },
  };
  assert.equal(
    (await controllerFor(database, down).current(auth)).data.destination.status,
    'pending_review',
  );

  answer = 'usable';
  await sweepPayoutSetup(database.db, { provider });
  assert.equal(
    (await withdrawalQuote(database.db, { profileId: TOBI, provider })).state,
    'ready',
  );
});

test('a read never brings a replaced or rejected account back', async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs({ payoutDestinationStatus: async () => 'usable' });
  await setPayoutDestination(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    destinationRef: 'pd_1',
    bankCode: '058',
    bankName: 'Guaranty Trust Bank',
    last4: '6789',
    status: 'rejected',
  });
  await sweepPayoutSetup(database.db, { provider });
  const { data } = await controllerFor(database, provider).current(auth);
  assert.equal(data.destination.status, 'rejected');
});

test("a bank added on the provider's hosted page is not usable: only this card makes one", async (t) => {
  const database = await setUp(t);
  // The hosted page has added a destination: the provider's capability turns active and its
  // requirement clears. TipMe has no record of that destination.
  const provider = fakeBachs();
  await new WebhookService({ db: database.db }).applyBachs(
    {
      kind: 'account',
      eventId: 'evt_hosted',
      eventType: 'account.updated',
      accountReference: ACCOUNT,
    },
    provider,
  );
  await sweepPayoutSetup(database.db, { provider });
  assert.equal(
    (await database.rows(`SELECT id FROM payout_destinations`)).length,
    0,
  );
  assert.equal(
    (await withdrawalQuote(database.db, { profileId: TOBI, provider })).state,
    'no_destination',
  );
  await assert.rejects(
    requestWithdrawal(database.db, {
      profileId: TOBI,
      amountMinor: 100000n,
      idempotencyKey: randomUUID(),
      provider,
    }),
    { code: 'PAYOUT_DESTINATION_NEEDED' },
  );
});

test('resolving says the name, or that it did not resolve, and stores nothing', async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs();
  const controller = controllerFor(database, provider);
  const body = { bankCode: '058', accountNumber: NUMBER };
  assert.deepEqual((await controller.resolve(auth, body)).data, {
    resolved: true,
    accountName: 'TOBI ADEYEMI',
  });
  const missing = controllerFor(
    database,
    fakeBachs({ resolveBankAccount: async () => null }),
  );
  assert.deepEqual((await missing.resolve(auth, body)).data, {
    resolved: false,
  });
  assert.equal(
    (await database.rows(`SELECT id FROM payout_destinations`)).length,
    0,
  );
});

test('through HTTP: signed-in and CSRF only, and the request log holds no account number', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  const stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  t.after(() => stack.stop());
  const send = (method, path, body, cookie, headers = browserHeaders(cookie)) =>
    fetch(`${stack.api}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  assert.equal((await send('GET', '/v1/payout-banks')).status, 401);
  assert.equal((await send('GET', '/v1/me/payout-destination')).status, 401);

  const email = `a@${uniquePrefix()}.example`;
  const [local, domain] = email.split('@');
  const hint = `${local[0]}•••@${domain}`;
  const seen = new Set();
  const nextCode = async (subject) => {
    for (let i = 0; i < 100; i++) {
      const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
      const mail = data.find(
        (m) =>
          m.to === hint &&
          m.subject?.toLowerCase().includes(subject) &&
          !seen.has(m.id),
      );
      if (mail) {
        seen.add(mail.id);
        return /\b(\d{6})\b/.exec(mail.body)[1];
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('no code arrived');
  };
  await send('POST', '/v1/auth/code', { email });
  const verify = await send('POST', '/v1/auth/verify', {
    email,
    code: await nextCode('sign-in code'),
  });
  assert.equal(verify.status, 200);
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  assert.equal(
    (await send('POST', '/v1/me/page', { handle: 'bank_owner' }, cookie))
      .status,
    201,
  );

  const banks = await send('GET', '/v1/payout-banks', undefined, cookie);
  assert.equal(banks.status, 200);
  const [bank] = (await banks.json()).data;
  assert.ok(bank.code && bank.name);

  // Without the browser's CSRF header, nothing that writes runs.
  const noCsrf = await send(
    'POST',
    '/v1/me/payout-destination/code',
    undefined,
    cookie,
    { 'content-type': 'application/json', cookie },
  );
  assert.equal(noCsrf.status, 403);

  const resolved = await send(
    'POST',
    '/v1/me/payout-destination/resolve',
    { bankCode: bank.code, accountNumber: NUMBER },
    cookie,
  );
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).data.resolved, true);

  assert.equal(
    (await send('POST', '/v1/me/payout-destination/code', undefined, cookie))
      .status,
    202,
  );
  const put = await send(
    'PUT',
    '/v1/me/payout-destination',
    {
      bankCode: bank.code,
      accountNumber: NUMBER,
      accountName: 'PRETEND ACCOUNT HOLDER',
      emailCode: await nextCode('bank account'),
    },
    cookie,
  );
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).data, {
    status: 'usable',
    bankName: bank.name,
    last4: '6789',
  });

  const read = await send(
    'GET',
    '/v1/me/payout-destination',
    undefined,
    cookie,
  );
  assert.equal(read.status, 200);
  assert.match(read.headers.get('cache-control') ?? '', /no-store/);
  assert.equal((await read.json()).data.destination.status, 'usable');

  // A bad number's validation error names the field, never the value.
  const bad = await send(
    'POST',
    '/v1/me/payout-destination/resolve',
    { bankCode: bank.code, accountNumber: '12345' },
    cookie,
  );
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await bad.text(), /12345/);

  assert.ok(stack.logs.length > 0);
  assert.doesNotMatch(JSON.stringify(stack.logs), new RegExp(NUMBER));
  const [row] = await database.pool
    .query(`SELECT * FROM payout_destinations`)
    .then((r) => r.rows);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(NUMBER));
});

test('the worker runs the sweep on a copy that runs the provider', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  // No accounts, so nothing is sent anywhere: this proves the schedule and the job are wired.
  const stack = await startStack({
    databaseUrl: database.url,
    workerEnv: {
      PAYMENT_PROVIDER: 'bachs-sandbox',
      BACHS_SANDBOX_API_KEY: 'sk_sandbox_integration_only',
    },
  });
  t.after(() => stack.stop());
  for (let i = 0; i < 100; i++) {
    if (stack.logs.some((entry) => entry.event === 'payout_setup.swept')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(stack.logs.some((entry) => entry.event === 'payout_setup.swept'));
});

const HOLD_HOURS = 72;
const ATTACKER = 'attacker@example.test';

const assertHeld = async (promise) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.getStatus?.() ?? error.status, 409);
    assert.match(
      JSON.stringify(error.getResponse?.() ?? error.code),
      /BANK_CHANGE_HELD/,
    );
    return true;
  });

async function moveEmailByChange(database) {
  await ops.requestEmailChangeCode(database.db, sealing, {
    userId: TOBI_USER,
    email: ATTACKER,
    secret: SECRET,
  });
  const code = (await queuedMail(database.db, sealing, { limit: 50 })).find(
    (mail) => mail.type === 'email_change_code',
  ).data.code;
  const moved = await ops.changeEmail(database.db, sealing, {
    userId: TOBI_USER,
    email: ATTACKER,
    code,
    secret: SECRET,
    keepSessionId: randomUUID(),
  });
  assert.equal(moved.status, 'ok');
}

const changedAt = async ({ rows }) =>
  (
    await rows(`SELECT email_changed_at AS at FROM users WHERE id = $1`, [
      TOBI_USER,
    ])
  )[0].at;

test('the wait is one named period of 72 hours', () => {
  assert.equal(ops.BANK_CHANGE_HOLD_MS, HOLD_HOURS * 3_600_000);
});

test('a stolen session: after an email change no code, no bank, and the old bank still pays', async (t) => {
  const database = await setUp(t);
  await seedPaidTip(database);
  const provider = fakeBachs();
  const controller = controllerFor(database, provider);
  await addBank(database, controller);
  const added = provider.named('addPayoutDestination').length;
  await database.pool.query(`DELETE FROM email_codes`);
  await moveEmailByChange(database);

  await assertHeld(controller.requestCode(auth));
  assert.equal(
    (await queuedMail(database.db, sealing, { limit: 50 })).filter(
      (mail) => mail.type === 'payout_destination_code' && mail.to === ATTACKER,
    ).length,
    0,
  );
  await assertHeld(
    controller.update(auth, {
      bankCode: '058',
      accountNumber: '9999999999',
      accountName: 'ATTACKER',
      emailCode: '123456',
    }),
  );
  assert.equal(provider.named('addPayoutDestination').length, added);

  const { data } = await controller.current(auth);
  assert.equal(data.destination.last4, '6789');
  assert.equal(
    new Date(data.bankChangesFrom).getTime(),
    (await changedAt(database)).getTime() + HOLD_HOURS * 3_600_000,
  );

  const { payoutId } = await requestWithdrawal(database.db, {
    profileId: TOBI,
    amountMinor: 200000n,
    idempotencyKey: randomUUID(),
    provider,
  });
  const [row] = await database.rows(
    `SELECT d.account_last4 AS last4 FROM payouts p
       JOIN payout_destinations d ON d.id = p.destination_id WHERE p.id = $1`,
    [payoutId],
  );
  assert.equal(row.last4, '6789');
});

test('the wait applies to a first add, is checked again in the save, and ends', async (t) => {
  const database = await setUp(t);
  const controller = controllerFor(database, fakeBachs());
  const code = await freshCode(database, controller);
  await moveEmailByChange(database);
  // A code issued before the move, for an address no longer the account's, is no way round.
  await assertHeld(
    controller.update(auth, {
      bankCode: '058',
      accountNumber: NUMBER,
      accountName: 'TOBI ADEYEMI',
      emailCode: code,
    }),
  );
  const direct = {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    destinationRef: 'pd_1',
    bankCode: '058',
    bankName: 'Guaranty Trust Bank',
    last4: '6789',
    status: 'usable',
  };
  await assert.rejects(setPayoutDestination(database.db, direct), {
    code: 'BANK_CHANGE_HELD',
  });

  const set = (hours) =>
    database.pool.query(
      `UPDATE users SET email_changed_at = now() - make_interval(hours => $1) WHERE id = $2`,
      [hours, TOBI_USER],
    );
  await set(HOLD_HOURS - 1);
  await assert.rejects(setPayoutDestination(database.db, direct), {
    code: 'BANK_CHANGE_HELD',
  });
  await set(HOLD_HOURS + 1);
  assert.equal((await controller.current(auth)).data.bankChangesFrom, null);
  const { data } = await addBank(database, controller);
  assert.equal(data.status, 'usable');
});

test('every path that changes a sign-in email starts the wait; repeating the same address does not', async (t) => {
  const database = await setUp(t);
  const verifyToken = async (email) => {
    const token = randomBytes(32).toString('base64url');
    await database.pool.query(
      `INSERT INTO email_tokens (token_sha256, user_id, email, purpose, expires_at)
       VALUES ($1, $2, $3, 'verify', now() + interval '1 hour')`,
      [createHash('sha256').update(token).digest('hex'), TOBI_USER, email],
    );
    return token;
  };
  const clear = () =>
    database.pool.query(`UPDATE users SET email_changed_at = NULL`);
  const paths = {
    changeEmail: () => moveEmailByChange(database),
    confirmEmail: async () =>
      assert.equal(
        await ops.confirmEmail(database.db, {
          token: await verifyToken('legacy-a@example.test'),
        }),
        'confirmed',
      ),
    confirmEmailForUser: async () =>
      assert.equal(
        (
          await ops.confirmEmailForUser(database.db, {
            token: await verifyToken('legacy-b@example.test'),
          })
        ).status,
        'confirmed',
      ),
    setAccountEmail: async () =>
      assert.equal(
        await ops.setAccountEmail(database.db, {
          handle: 'tobi',
          email: 'scripted@example.test',
          reason: 'Support case proven by the owner',
        }),
        'set',
      ),
    'recovery completion (user or staff)': async () => {
      await database.pool.query(
        `INSERT INTO email_recoveries
           (id, user_id, new_email, started_by, effective_at, created_at)
         VALUES ($1, $2, 'recovered@example.test', 'staff', now() - interval '1 minute', now())`,
        [randomUUID(), TOBI_USER],
      );
      assert.equal(
        await ops.completeDueRecoveries(database.db, sealing, new Date()),
        1,
      );
    },
  };
  for (const [name, run] of Object.entries(paths)) {
    await clear();
    await run();
    assert.ok(await changedAt(database), `${name} must start the wait`);
  }

  await clear();
  assert.equal(
    await ops.setAccountEmail(database.db, {
      handle: 'tobi',
      email: 'recovered@example.test',
      reason: 'Support case proven by the owner',
    }),
    'set',
  );
  assert.equal(await changedAt(database), null, 'same address, no change');
});

test('a read that says not found is unknown: never rejected, and a good account stays', async (t) => {
  const database = await setUp(t);
  const logs = [];
  let read = async () => 'usable';
  const provider = fakeBachs({
    payoutDestinationStatus: (...args) => read(...args),
  });
  const controller = controllerFor(database, provider, logs);
  await addBank(database, controller);
  read = async () => {
    throw new Error('not found');
  };
  const { data } = await addBank(database, controller, {
    accountNumber: '9999999999',
  });
  assert.equal(data.status, 'pending_review');
  assert.ok(logs.some((entry) => entry.step === 'read'));
  read = async () => 'usable';
  assert.equal(
    (await controller.current(auth)).data.destination.status,
    'usable',
  );
});

test('a rejected replacement is refused and the usable account stays current, with no notice', async (t) => {
  const database = await setUp(t);
  let read = async () => 'usable';
  const provider = fakeBachs({
    payoutDestinationStatus: (...args) => read(...args),
  });
  const controller = controllerFor(database, provider);
  await addBank(database, controller);
  read = async () => 'rejected';
  await assert.rejects(
    addBank(database, controller, { accountNumber: '9999999999' }),
    (error) => {
      assert.equal(error.getStatus?.() ?? 422, 422);
      assert.match(
        JSON.stringify(error.getResponse?.() ?? error.code),
        /PAYOUT_DESTINATION_REFUSED/,
      );
      return true;
    },
  );
  assert.deepEqual(
    await database.rows(
      `SELECT account_last4 AS last4, status, replaced_at FROM payout_destinations`,
    ),
    [{ last4: '6789', status: 'usable', replaced_at: null }],
  );
  assert.equal((await notices(database)).length, 0);
  assert.equal(
    (await withdrawalQuote(database.db, { profileId: TOBI, provider })).state,
    'ready',
  );
});

test('a pending replacement still takes the slot', async (t) => {
  const database = await setUp(t);
  let read = async () => 'usable';
  const provider = fakeBachs({
    payoutDestinationStatus: (...args) => read(...args),
  });
  const controller = controllerFor(database, provider);
  await addBank(database, controller);
  read = async () => 'pending_review';
  const { data } = await addBank(database, controller, {
    accountNumber: '9999999999',
  });
  assert.deepEqual(data, {
    status: 'pending_review',
    bankName: 'Guaranty Trust Bank',
    last4: '9999',
  });
  assert.equal((await notices(database)).length, 1);
});

test('a failed read records pending, whatever the add replayed', async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs({
    payoutDestinationStatus: async () => {
      throw new Error('down');
    },
  });
  const { data } = await addBank(database, controllerFor(database, provider));
  assert.equal(data.status, 'pending_review');
});

test('sending a rejected account again never raises it, read or no read', async (t) => {
  const database = await setUp(t);
  let read = async () => 'rejected';
  const provider = fakeBachs({
    payoutDestinationStatus: (...args) => read(...args),
  });
  const controller = controllerFor(database, provider);
  assert.equal((await addBank(database, controller)).data.status, 'rejected');
  read = async () => {
    throw new Error('down');
  };
  assert.equal((await addBank(database, controller)).data.status, 'rejected');
  read = async () => 'usable';
  assert.equal((await addBank(database, controller)).data.status, 'rejected');
});

test('no onboarding link until manual payouts are recorded', async (t) => {
  const database = await setUp(t, { manual: false });
  await database.pool.query(
    `UPDATE payment_accounts SET status = 'ONBOARDING', charges_enabled = false`,
  );
  const links = [];
  const pending = async (reference) => ({
    accountReference: reference,
    active: false,
    ngnCardCollectionStatus: 'pending',
    bankTransferStatus: 'pending',
    feeCollector: 'platform',
    requirementsDue: ['payout_destination'],
    holdsLocalCurrency: true,
  });
  const createOnboardingLink = async () => {
    links.push('made');
    return 'https://hosted.example/x';
  };
  const failing = fakeBachs({
    setManualPayouts: async () => {
      throw new Error('down');
    },
    getRecipientAccount: pending,
    createOnboardingLink,
  });
  await assert.rejects(onboard(database, failing), { status: 503 });
  assert.deepEqual(links, []);

  const working = fakeBachs({
    getRecipientAccount: pending,
    createOnboardingLink,
  });
  const { data } = await onboard(database, working);
  assert.equal(data.onboardingUrl, 'https://hosted.example/x');
  assert.ok(await manualAt(database));
});

test('resolving needs a confirmed email and a payment account', async (t) => {
  const database = await setUp(t);
  const provider = fakeBachs();
  const controller = controllerFor(database, provider);
  const body = { bankCode: '058', accountNumber: NUMBER };
  await database.pool.query(`DELETE FROM payment_accounts`);
  await assert.rejects(controller.resolve(auth, body), { status: 409 });
  await database.pool.query(
    `UPDATE users SET email_verified_at = NULL WHERE id = $1`,
    [TOBI_USER],
  );
  await assert.rejects(controller.resolve(auth, body), { status: 409 });
  assert.equal(provider.named('resolveBankAccount').length, 0);
});

/** The rate limit guard, on a fake Redis that counts or breaks. */
function guardFor(route, { broken = false } = {}) {
  const counts = new Map();
  const redis = {
    multi() {
      let key;
      const chain = {
        incr: (k) => ((key = k), chain),
        expire: () => chain,
        exec: async () => {
          if (broken) throw new Error('redis down');
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return [
            [null, counts.get(key)],
            [null, 1],
          ];
        },
      };
      return chain;
    },
  };
  const guard = new RateLimitGuard(
    { get: () => route },
    redis,
    {
      QUEUE_PREFIX: 'guard-test',
      RATE_LIMIT_BANK_RESOLVE_PER_HOUR: 100000,
      RATE_LIMIT_BANK_READ_PER_MIN: 3,
      RATE_LIMIT_AUTH_PER_HOUR: 100000,
    },
    { warn() {}, info() {}, error() {} },
  );
  const call = (ip, userId = TOBI_USER) =>
    guard.canActivate({
      getHandler: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ ip, auth: { userId } }),
      }),
    });
  return { call, counts };
}

test('resolving is limited to 10 a day per person, however many addresses they use', async () => {
  const { call } = guardFor('bank_resolve');
  for (let i = 0; i < 10; i += 1) assert.equal(await call(`10.0.0.${i}`), true);
  await assert.rejects(
    call('10.0.1.1'),
    (error) => error.retryAfterSeconds > 0,
  );
  assert.equal(await call('10.0.1.2', 'someone-else'), true);
});

test('resolving has its own bucket, apart from sign-in', async () => {
  const { call, counts } = guardFor('bank_resolve');
  await call('10.0.0.1');
  const keys = [...counts.keys()];
  assert.ok(keys.length >= 2);
  assert.ok(keys.every((key) => key.includes(':bank_resolve:')));
});

test('if Redis errors, resolving fails closed and sign-in stays open', async () => {
  await assert.rejects(
    guardFor('bank_resolve', { broken: true }).call('10.0.0.1'),
    {
      status: 503,
    },
  );
  assert.equal(
    await guardFor('auth_verify', { broken: true }).call('10.0.0.1'),
    true,
  );
  assert.equal(
    await guardFor('bank_read', { broken: true }).call('10.0.0.1'),
    true,
  );
});

test('reads are limited per person', async () => {
  const { call } = guardFor('bank_read');
  for (let i = 0; i < 3; i += 1) await call('10.0.0.1');
  await assert.rejects(call('10.0.0.9'));
  assert.equal(await call('10.0.0.1', 'someone-else'), true);
});

test('the bank list is cached; a failure is not', async (t) => {
  const database = await setUp(t);
  let fail = true;
  const provider = fakeBachs();
  const list = provider.listBanks;
  provider.listBanks = async (...args) => {
    if (fail) throw new Error('down');
    return list(...args);
  };
  const controller = controllerFor(database, provider);
  await assert.rejects(controller.banks(), { status: 503 });
  fail = false;
  await controller.banks();
  await controller.banks();
  await addBank(database, controller);
  assert.equal(provider.named('listBanks').length, 1);
  t.mock.method(Date, 'now', () => new Date().getTime() + 25 * 3_600_000);
  await controller.banks();
  assert.equal(provider.named('listBanks').length, 2);
});

const failingManual = (overrides = {}) =>
  fakeBachs({
    setManualPayouts: async () => {
      throw new Error('provider down');
    },
    ...overrides,
  });

const setupIssues = ({ rows }) =>
  rows(
    `SELECT status, severity, subject, summary, resolved_by
       FROM issues WHERE kind = 'payment_account_setup_failed'`,
  );

test('a failed setup tells staff once, by any path, and closes itself once set', async (t) => {
  const database = await setUp(t, { manual: false });
  const provider = failingManual();
  await sweepPayoutSetup(database.db, { provider });
  await new WebhookService({ db: database.db }).applyBachs(
    {
      kind: 'account',
      eventId: 'evt_issue',
      eventType: 'account.updated',
      accountReference: ACCOUNT,
    },
    provider,
  );
  await onboard(database, provider); // An active account: no link to withhold.
  const open = await setupIssues(database);
  assert.equal(open.length, 1);
  assert.equal(open[0].status, 'open');
  assert.equal(open[0].severity, 'account');
  assert.deepEqual(Object.keys(open[0].subject).sort(), [
    'profileId',
    'userId',
  ]);
  assert.doesNotMatch(JSON.stringify(open[0]), new RegExp(ACCOUNT));

  await sweepPayoutSetup(database.db, { provider: fakeBachs() });
  const [closed] = await setupIssues(database);
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolved_by, 'system');
});

test('each path that sees a failure opens the issue on its own', async (t) => {
  const database = await setUp(t, { manual: false });
  await new WebhookService({ db: database.db }).applyBachs(
    {
      kind: 'account',
      eventId: 'evt_alone',
      eventType: 'account.updated',
      accountReference: ACCOUNT,
    },
    failingManual(),
  );
  assert.equal((await setupIssues(database)).length, 1);
  await database.pool.query(`DELETE FROM issues`);
  await onboard(database, failingManual());
  assert.equal((await setupIssues(database)).length, 1);
});

test('an issue left open after the account was set closes on the regular check', async (t) => {
  const database = await setUp(t, { manual: false });
  await sweepPayoutSetup(database.db, { provider: failingManual() });
  await database.pool.query(
    `UPDATE payment_accounts SET manual_payouts_at = now()`,
  );
  await ops.autoResolveIssues(database.db, new Date());
  assert.equal((await setupIssues(database))[0].status, 'resolved');
});

test('a failure on the webhook path is logged, with no account data', async (t) => {
  const database = await setUp(t, { manual: false });
  const logs = [];
  await new WebhookService({ db: database.db }, sealing, {
    info() {},
    warn: (entry) => logs.push(entry),
    error() {},
  }).applyBachs(
    {
      kind: 'account',
      eventId: 'evt_log',
      eventType: 'account.updated',
      accountReference: ACCOUNT,
    },
    failingManual(),
  );
  assert.ok(
    logs.some(
      (entry) => entry.event === 'payment_account.manual_payouts_failed',
    ),
  );
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(ACCOUNT));
});

async function secondAccount(database) {
  await database.pool.query(
    `INSERT INTO payment_accounts
       (id, profile_id, provider, environment, provider_account_reference, status,
        charges_enabled, payouts_enabled, fee_collector)
     VALUES ($1, $2, 'bachs', 'sandbox', 'acct_ada123', 'ACTIVE', true, false, 'platform')`,
    [randomUUID(), ADA],
  );
}

test('a sweep stops early on repeated failures, and the next one starts with the others', async (t) => {
  const database = await setUp(t, { manual: false });
  await secondAccount(database);
  const logs = [];
  const seen = [];
  const provider = failingManual({
    setManualPayouts: async (reference) => {
      seen.push(reference);
      throw new Error('provider down');
    },
  });
  const first = await sweepPayoutSetup(database.db, {
    provider,
    maxFailuresInARow: 1,
    log: (entry) => logs.push(entry),
  });
  assert.equal(first.stoppedEarly, true);
  assert.equal(first.checked, 1);
  assert.equal(seen.length, 1);
  assert.ok(logs.some((entry) => entry.event === 'payout_setup.sweep_stopped'));

  await sweepPayoutSetup(database.db, { provider, maxFailuresInARow: 1 });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'a dead account must not block the rest');
});

test('the default stop is a named count, and a success resets it', async (t) => {
  assert.equal(ops.PAYOUT_SWEEP_MAX_FAILURES_IN_A_ROW, 5);
  const database = await setUp(t, { manual: false });
  await secondAccount(database);
  let calls = 0;
  const provider = fakeBachs({
    setManualPayouts: async () => {
      calls += 1;
      if (calls === 1) throw new Error('one bad account');
    },
  });
  const swept = await sweepPayoutSetup(database.db, {
    provider,
    maxFailuresInARow: 2,
  });
  assert.equal(swept.stoppedEarly, false);
  assert.equal(swept.checked, 2);
});

test('through HTTP: ten lookups a day for one person, then 429; another person is unaffected', async (t) => {
  const database = await openTestDatabase();
  t.after(() => database.close());
  await database.reset();
  const stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_BANK_RESOLVE_PER_HOUR: '1000',
    },
  });
  t.after(() => stack.stop());
  const post = (path, body, cookie) =>
    fetch(`${stack.api}${path}`, {
      method: 'POST',
      headers: browserHeaders(cookie),
      body: JSON.stringify(body),
    });
  const signUp = async (handle) => {
    const domain = `${uniquePrefix()}.example`;
    const email = `a@${domain}`;
    await post('/v1/auth/code', { email });
    let code;
    for (let i = 0; i < 100 && !code; i += 1) {
      const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
      const mail = data.find((m) => m.to === `a•••@${domain}`);
      code = mail && /\b(\d{6})\b/.exec(mail.body)?.[1];
      if (!code) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const verify = await post('/v1/auth/verify', { email, code });
    assert.equal(verify.status, 200);
    const cookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    assert.equal((await post('/v1/me/page', { handle }, cookie)).status, 201);
    return cookie;
  };
  const a = await signUp('limit_a');
  const b = await signUp('limit_b');
  const resolve = (cookie) =>
    post(
      '/v1/me/payout-destination/resolve',
      { bankCode: '058', accountNumber: NUMBER },
      cookie,
    );
  for (let i = 0; i < 10; i += 1) assert.equal((await resolve(a)).status, 200);
  const limited = await resolve(a);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await resolve(b)).status, 200);
});

/** Accounts on pages of their own, none with manual payouts or capabilities recorded yet. */
async function moreAccounts(database, count) {
  for (let i = 0; i < count; i += 1) {
    const profile = randomUUID();
    await database.pool.query(
      `INSERT INTO profiles (id, handle, handle_lower, display_name)
       VALUES ($1, $2, $2, 'Sweep test')`,
      [profile, `sweep_${i}`],
    );
    await database.pool.query(
      `INSERT INTO payment_accounts
         (id, profile_id, provider, environment, provider_account_reference, status,
          charges_enabled, payouts_enabled, fee_collector)
       VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, false, 'platform')`,
      [randomUUID(), profile, `acct_sweep_${i}`],
    );
  }
}

test('dead accounts stop the account phase, and a bank under review still settles on that sweep', async (t) => {
  const database = await setUp(t);
  await moreAccounts(database, ops.PAYOUT_SWEEP_MAX_FAILURES_IN_A_ROW);
  await setPayoutDestination(database.db, {
    sealing,
    profileId: TOBI,
    provider: 'bachs',
    destinationRef: 'pd_pending',
    bankCode: '058',
    bankName: 'Guaranty Trust Bank',
    last4: '6789',
    status: 'pending_review',
  });
  const swept = await sweepPayoutSetup(database.db, {
    provider: failingManual(),
  });
  assert.equal(swept.stoppedEarly, true);
  assert.equal(swept.destinationsSettled, 1);
  const [row] = await database.rows(
    `SELECT status FROM payout_destinations WHERE profile_id = $1`,
    [TOBI],
  );
  assert.equal(row.status, 'usable');
});

/** Banks under review on `count` new accounts. */
async function pendingBanks(database, count) {
  await moreAccounts(database, count);
  const { rows } = await database.pool.query(
    `SELECT id FROM profiles WHERE handle LIKE 'sweep_%' ORDER BY handle`,
  );
  for (const [index, { id }] of rows.entries())
    await setPayoutDestination(database.db, {
      sealing,
      profileId: id,
      provider: 'bachs',
      destinationRef: `pd_${index}`,
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      last4: '6789',
      status: 'pending_review',
    });
  await database.pool.query(
    `UPDATE payment_accounts SET manual_payouts_at = now(),
       payout_capabilities_requested_at = now()`,
  );
}

test('a sweep reads at most its cap of pending banks, and every bank gets its turn across runs', async (t) => {
  const database = await setUp(t);
  await pendingBanks(database, 3);
  assert.ok(ops.PAYOUT_SWEEP_MAX_DESTINATION_READS >= 1);
  const seen = new Set();
  for (let run = 0; run < 60; run += 1) {
    const reads = [];
    await sweepPayoutSetup(database.db, {
      provider: fakeBachs({
        payoutDestinationStatus: async (_account, ref) => {
          reads.push(ref);
          return 'pending_review';
        },
      }),
      maxDestinationReads: 1,
    });
    assert.equal(reads.length, 1);
    seen.add(reads[0]);
  }
  assert.deepEqual([...seen].sort(), ['pd_0', 'pd_1', 'pd_2']);
});

test('consecutive 429s stop the pending reads, since they share a key with payouts', async (t) => {
  const database = await setUp(t);
  const banks = ops.PAYOUT_SWEEP_MAX_RATE_LIMITED_IN_A_ROW + 3;
  await pendingBanks(database, banks);
  let reads = 0;
  const logged = [];
  const swept = await sweepPayoutSetup(database.db, {
    provider: fakeBachs({
      payoutDestinationStatus: async () => {
        reads += 1;
        throw Object.assign(new Error('limited'), {
          name: 'BachsApiError',
          statusCode: 429,
        });
      },
    }),
    log: (entry) => logged.push(entry),
  });
  assert.equal(reads, ops.PAYOUT_SWEEP_MAX_RATE_LIMITED_IN_A_ROW);
  assert.equal(swept.destinationReadsFailed, reads);
  assert.equal(swept.destinationReadsStopped, true);
  assert.ok(
    logged.some(
      (entry) =>
        entry.event === 'payout_setup.destination_reads_stopped' &&
        entry.error === 'rate_limited',
    ),
  );
});

test('a 429 between good reads, or another failure, does not stop the pending reads', async (t) => {
  const database = await setUp(t);
  await pendingBanks(database, 5);
  let reads = 0;
  const swept = await sweepPayoutSetup(database.db, {
    provider: fakeBachs({
      payoutDestinationStatus: async () => {
        reads += 1;
        if (reads % 2)
          throw Object.assign(new Error('limited'), { statusCode: 429 });
        return 'pending_review';
      },
    }),
  });
  assert.equal(reads, 5);
  assert.equal(swept.destinationReadsStopped, false);
  assert.equal(swept.destinationReadsFailed, 3);
  reads = 0;
  const down = await sweepPayoutSetup(database.db, {
    provider: fakeBachs({
      payoutDestinationStatus: async () => {
        reads += 1;
        throw Object.assign(new Error('down'), { statusCode: 500 });
      },
    }),
  });
  assert.equal(reads, 5);
  assert.equal(down.destinationReadsStopped, false);
});

test('a sweep sets up at most its cap of accounts, oldest tried first, and the rest wait for the next run', async (t) => {
  const database = await setUp(t, { manual: false });
  await moreAccounts(database, 3);
  const first = await sweepPayoutSetup(database.db, {
    provider: fakeBachs(),
    maxAccounts: 2,
  });
  assert.equal(first.checked, 2);
  assert.equal(first.accountsCapped, true);
  const second = await sweepPayoutSetup(database.db, {
    provider: fakeBachs(),
    maxAccounts: 2,
  });
  assert.equal(second.checked, 2);
  assert.equal(second.accountsCapped, false);
  assert.ok(ops.PAYOUT_SWEEP_MAX_ACCOUNTS >= 1);
});

test('consecutive 429s stop the account phase, on the capability read too', async (t) => {
  const database = await setUp(t, { manual: false });
  await moreAccounts(database, ops.PAYOUT_SWEEP_MAX_RATE_LIMITED_IN_A_ROW + 3);
  const logged = [];
  const limited = async () => {
    throw Object.assign(new Error('limited'), { statusCode: 429 });
  };
  const swept = await sweepPayoutSetup(database.db, {
    provider: fakeBachs({
      payoutCapability: limited,
      setManualPayouts: async () => undefined,
    }),
    log: (entry) => logged.push(entry),
  });
  assert.equal(swept.checked, ops.PAYOUT_SWEEP_MAX_RATE_LIMITED_IN_A_ROW);
  assert.equal(swept.stoppedEarly, true);
  assert.ok(
    logged.some(
      (entry) =>
        entry.event === 'payout_setup.sweep_stopped' &&
        entry.error === 'rate_limited',
    ),
  );
});

test('banks that can not be read never stop the others being read', async (t) => {
  const database = await setUp(t);
  await moreAccounts(database, 2);
  const { rows: profiles } = await database.pool.query(
    `SELECT id FROM profiles WHERE handle LIKE 'sweep_%' ORDER BY handle`,
  );
  const add = (profileId, destinationRef) =>
    setPayoutDestination(database.db, {
      sealing,
      profileId,
      provider: 'bachs',
      destinationRef,
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      last4: '6789',
      status: 'pending_review',
    });
  await add(profiles[0].id, 'pd_dead_1');
  await add(profiles[1].id, 'pd_dead_2');
  await add(TOBI, 'pd_good');
  const swept = await sweepPayoutSetup(database.db, {
    maxFailuresInARow: 1,
    provider: fakeBachs({
      payoutDestinationStatus: async (_account, reference) => {
        if (reference !== 'pd_good') throw new Error('down');
        return 'usable';
      },
    }),
  });
  assert.equal(swept.destinationsSettled, 1);
  assert.equal(swept.stoppedEarly, false);
});

test('repeated capability failures alone do not stop the run', async (t) => {
  const database = await setUp(t);
  const count = ops.PAYOUT_SWEEP_MAX_FAILURES_IN_A_ROW + 2;
  await moreAccounts(database, count);
  const provider = fakeBachs({
    payoutCapability: async () => {
      throw new Error('capability read down');
    },
  });
  const swept = await sweepPayoutSetup(database.db, { provider });
  assert.equal(swept.stoppedEarly, false);
  assert.equal(swept.checked, count);
  assert.equal(swept.failed, count);
  assert.equal(provider.named('setManualPayouts').length, count);
});
