import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PaymentAccountsController } from '../../apps/api/dist/profiles/payment-accounts.controller.js';
import { PayoutDestinationController } from '../../apps/api/dist/profiles/payout-destination.controller.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
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
import { TOBI } from '../../packages/database/test/integration/helpers.mjs';
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
  assert.equal((await controller.current(auth)).data.status, 'rejected');
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
    (await controllerFor(database, down).current(auth)).data.status,
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
  assert.equal(data.status, 'rejected');
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
