import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
  BachsRequestNotSentError,
  CollectTransferRefusedError,
  PlatformRefusalError,
  UncertainProviderOutcomeError,
  UnlistedNegativeBalanceError,
  createBachsProvider,
} from '../dist/index.js';

/*
 * You collect (plan Task 4): tips charged on TipMe's own account, and each recipient's share
 * transferred to their receive-only person account. The Global Constraints forbid any call to the
 * partner here, so every body comes from test/fixtures/collect, each with a `_source` naming the doc
 * page or the recorded sandbox fixture it was built from. Nothing here reaches the network.
 */
const PLATFORM_ORG = 'acct_stWbI4933A4WVqkc';
const PERSON = 'acct_Pn4rS0nQw8Lk2Vb7';
const ATTEMPT = '0193f7a2-0000-7000-8000-00000000c011';
const TIP = '0193f7a2-0000-7000-8000-0000000071b5';
const KEY = `tipme-collect-${TIP}`;
const SANDBOX_HOST = 'sandbox-api.bachs.io';

function fixture(name) {
  const raw = JSON.parse(
    readFileSync(new URL(`./fixtures/collect/${name}.json`, import.meta.url)),
  );
  assert.equal(typeof raw._source, 'string', `${name} names its source`);
  return raw;
}

/** A fixture's body as the partner sends it: the notes are ours, not theirs. */
function body(name) {
  const { _source, _status, ...rest } = fixture(name);
  return rest;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answer(name, fallbackStatus = 200) {
  return jsonResponse(body(name), fixture(name)._status ?? fallbackStatus);
}

// No real fetch can run in this file: the adapter only ever gets the fake below.
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw new Error('a real fetch was attempted');
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

function fake(answers, options = {}) {
  const calls = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const provider = createBachsProvider({
    ...options,
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: ['current-secret-0123456789'],
    platformOrganizationId: PLATFORM_ORG,
    fetchImpl: async (url, init) => {
      // Only the sandbox origin is ever formed.
      assert.equal(url.host, SANDBOX_HOST);
      assert.equal(url.protocol, 'https:');
      const call = {
        method: init.method,
        url: String(url),
        path: `${url.pathname}${url.search}`,
        headers: init.headers,
        rawBody: init.body,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(call);
      const next = queue
        ? queue.shift()
        : typeof answers === 'function'
          ? answers(call)
          : answers;
      if (next === undefined) throw new Error('unexpected request');
      const resolved = typeof next === 'function' ? next(call) : next;
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
  });
  return { provider, calls };
}

const collectCheckout = {
  attemptId: ATTEMPT,
  amountMinor: 1000000n,
  currency: 'NGN',
  successUrl: 'https://usetipme.xyz/checkout/return',
  cancelUrl: 'https://usetipme.xyz/checkout/cancel',
  idempotencyKey: `tipme-checkout-${ATTEMPT}`,
};

const collectTransfer = {
  accountRef: PERSON,
  amountMinor: 950000n,
  currency: 'NGN',
  idempotencyKey: KEY,
};

test("a collect checkout is on TipMe's own account with the attempt as reference and naira methods only", async () => {
  const { provider, calls } = fake([answer('checkout-created', 201)]);
  const result = await provider.initializeCollectCheckout(collectCheckout);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `https://${SANDBOX_HOST}/v1/checkout-sessions`);
  assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);
  assert.equal(call.headers['Idempotency-Key'], `tipme-checkout-${ATTEMPT}`);
  assert.equal(call.body.reference, ATTEMPT);
  assert.deepEqual(call.body.pricing, { amount: '10000.00', currency: 'NGN' });
  assert.deepEqual(call.body.payment_method_types, [
    'NGN_CARD',
    'NGN_BANK_TRANSFER',
  ]);
  assert.equal(call.body.customer_bears_fee, false);
  assert.equal(call.body.expires_in_minutes, 30);
  assert.equal(call.body.customer_creation, 'if_required');
  for (const absent of ['platform_fee', 'save_payment_method', 'customer'])
    assert.equal(Object.hasOwn(call.body, absent), false, absent);
  assert.ok(result.providerReference.startsWith('platform:'));
  assert.deepEqual(result, {
    providerReference: 'platform:cs_collect_7f2a',
    checkoutUrl: 'https://checkout.bachs.io/session/cs_collect_7f2a',
    expiresAt: new Date('2026-11-19T21:45:00Z'),
  });
});

test('a collect checkout refused for TipMe’s account is definite; bad input is never sent', async () => {
  const refused = fake([
    jsonResponse(
      { detail: 'not activated', error_code: 'ACCOUNT_NOT_ACTIVATED' },
      403,
    ),
  ]);
  await assert.rejects(
    refused.provider.initializeCollectCheckout(collectCheckout),
    (error) => error.name === 'PlatformCheckoutUnavailableError',
  );
  const { provider, calls } = fake([]);
  for (const bad of [
    { amountMinor: 0n },
    { currency: 'USD' },
    { attemptId: 'a:b' },
    { idempotencyKey: 'has space' },
    { successUrl: 'http://evil.example' },
  ])
    await assert.rejects(
      provider.initializeCollectCheckout({ ...collectCheckout, ...bad }),
      (error) => error.name === 'BachsRequestNotSentError',
    );
  assert.equal(calls.length, 0);
});

test('a collect checkout is read back with its charge and method, with no platform-fee expectation', async () => {
  const { provider, calls } = fake([
    answer('checkout-completed'),
    answer('payment-read'),
  ]);
  assert.deepEqual(
    await provider.verifyTransaction('platform:cs_collect_7f2a'),
    {
      status: 'succeeded',
      amountMinor: 1000000n,
      currency: 'NGN',
      feeMinor: 20000n,
      feePaidBy: 'platform',
      method: 'NGN_CARD',
      chargeReference: 'pay_collect_7f2a',
    },
  );
  for (const call of calls)
    assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);
});

test('a direct checkout request is byte-for-byte unchanged', async () => {
  const recorded = fixture('direct-checkout-request');
  const { provider, calls } = fake([
    jsonResponse(
      {
        checkout_id: 'chk_123abc',
        checkout_url: 'https://checkout.bachs.io/session/chk_123abc',
        status: 'open',
      },
      201,
    ),
  ]);
  await provider.initializePayment({
    attemptId: '0193f7a2-0000-7000-8000-00000000d1ec',
    amountMinor: 1000000n,
    currency: 'NGN',
    recipientAccountReference: 'acct_ZH5luf3xSXZkDevh',
    tipmeShareMinor: 50000n,
    successUrl: 'https://usetipme.xyz/checkout/return',
    cancelUrl: 'https://usetipme.xyz/checkout/cancel',
  });
  const [call] = calls;
  const { authorization, ...headers } = call.headers;
  assert.equal(authorization, 'Bearer sk_sandbox_test');
  assert.equal(call.method, recorded.method);
  assert.equal(call.url, recorded.url);
  // Key order too: the exact header list and the exact JSON string sent.
  assert.deepEqual(Object.entries(headers), Object.entries(recorded.headers));
  assert.equal(call.rawBody, JSON.stringify(recorded.body));
});

test("a person's receive-only account requests only payouts and transfers", async () => {
  const { provider, calls } = fake([
    answer('individual-account-created', 201),
    answer('individual-account-named'),
  ]);
  const account = await provider.createReceiveOnlyPersonAccount({
    contactEmail: 'ada@example.com',
    country: 'NG',
    legalName: { first: ' Ada ', last: 'Okafor' },
    idempotencyKey: `tipme-person-acct-${TIP}`,
  });
  assert.equal(calls.length, 2);
  const [create, name] = calls;
  assert.equal(create.method, 'POST');
  assert.equal(create.path, '/v1/accounts');
  assert.equal(Object.hasOwn(create.headers, 'X-Account-Id'), false);
  assert.equal(create.headers['Idempotency-Key'], `tipme-person-acct-${TIP}`);
  assert.equal(create.body.entity_type, 'individual');
  assert.equal(create.body.country, 'NG');
  assert.equal(create.body.contact_email, 'ada@example.com');
  assert.equal(create.body.configuration.merchant, undefined);
  assert.deepEqual(Object.keys(create.body.configuration), ['recipient']);
  assert.deepEqual(create.body.configuration.recipient.capabilities, {
    payouts: { requested: true },
    transfers: { requested: true },
  });
  assert.deepEqual(create.body.dashboard_features, { refunds: false });
  // Create's first_name and last_name only label the account (/connect/accounts); the legal name
  // is the person's, sent as fields.persons on the account update (/connect/requirements).
  assert.equal(create.body.first_name, 'Ada');
  assert.equal(create.body.last_name, 'Okafor');
  assert.equal(name.method, 'POST');
  assert.equal(name.path, `/v1/accounts/${PERSON}`);
  assert.equal(
    name.headers['Idempotency-Key'],
    `tipme-person-acct-${TIP}.name`,
  );
  assert.deepEqual(name.body, {
    fields: {
      persons: [
        {
          first_name: 'Ada',
          last_name: 'Okafor',
          relationship: { representative: true },
        },
      ],
    },
  });
  assert.equal(account.accountReference, PERSON);
  assert.deepEqual(account.requirementsDue, ['payout_destination']);
  // A new account holds only USD until holdLocalCurrency (P12).
  assert.equal(account.holdsLocalCurrency, false);
});

test('the legal name is always sent after create, even when the requirements omit it', async () => {
  // A fresh create whose requirements don't list the name (or list it only as eventually_due):
  // the name still goes, once per key, since a missing entry proves nothing about the person.
  for (const requirements of [
    { currently_due: ['payout_destination'], eventually_due: [], past_due: [] },
    {
      currently_due: ['payout_destination'],
      eventually_due: ['persons.name'],
      past_due: [],
    },
  ]) {
    const created = { ...body('individual-account-created'), requirements };
    const { provider, calls } = fake([
      jsonResponse(created, 201),
      answer('individual-account-named'),
    ]);
    await provider.createReceiveOnlyPersonAccount({
      contactEmail: 'ada@example.com',
      country: 'NG',
      legalName: { first: 'Ada', last: 'Okafor' },
      idempotencyKey: `tipme-person-acct-${TIP}`,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, `/v1/accounts/${PERSON}`);
    assert.equal(
      calls[1].headers['Idempotency-Key'],
      `tipme-person-acct-${TIP}.name`,
    );
    assert.deepEqual(calls[1].body.fields.persons[0].first_name, 'Ada');
  }
});

test('a person account needs a whole legal name; nothing is sent without one', async () => {
  const { provider, calls } = fake([]);
  for (const legalName of [
    { first: '', last: 'Okafor' },
    { first: 'Ada', last: '   ' },
    { first: 'Ada\u0000', last: 'Okafor' },
    { first: 'A'.repeat(256), last: 'Okafor' },
  ])
    await assert.rejects(
      provider.createReceiveOnlyPersonAccount({
        contactEmail: 'ada@example.com',
        country: 'NG',
        legalName,
        idempotencyKey: `tipme-person-acct-${TIP}`,
      }),
    );
  assert.equal(calls.length, 0);
});

test('the account reference is handed back the moment create returns, before the name is sent (Task 13)', async () => {
  const seen = [];
  const { provider, calls } = fake([
    answer('individual-account-created', 201),
    (call) => {
      seen.push(['name', call.path]);
      return answer('individual-account-named');
    },
  ]);
  await provider.createReceiveOnlyPersonAccount({
    contactEmail: 'ada@example.com',
    country: 'NG',
    legalName: { first: 'Ada', last: 'Okafor' },
    idempotencyKey: `tipme-person-acct-${TIP}`,
    async onCreated(reference) {
      seen.push(['created', reference]);
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, [
    ['created', PERSON],
    ['name', `/v1/accounts/${PERSON}`],
  ]);
});

test('a create whose reference could not be kept sends no name', async () => {
  const { provider, calls } = fake([answer('individual-account-created', 201)]);
  await assert.rejects(
    provider.createReceiveOnlyPersonAccount({
      contactEmail: 'ada@example.com',
      country: 'NG',
      legalName: { first: 'Ada', last: 'Okafor' },
      idempotencyKey: `tipme-person-acct-${TIP}`,
      async onCreated() {
        throw new Error('database down');
      },
    }),
    /database down/,
  );
  assert.equal(calls.length, 1);
});

test("an existing account is named on its own, with the caller's key, and nothing is created", async () => {
  const { provider, calls } = fake([answer('individual-account-named')]);
  const account = await provider.nameReceiveOnlyPerson({
    accountReference: PERSON,
    legalName: { first: ' Ada ', last: 'Okafor' },
    idempotencyKey: `tipme-collect-name-${TIP}`,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `/v1/accounts/${PERSON}`);
  assert.equal(
    calls[0].headers['Idempotency-Key'],
    `tipme-collect-name-${TIP}`,
  );
  assert.deepEqual(calls[0].body, {
    fields: {
      persons: [
        {
          first_name: 'Ada',
          last_name: 'Okafor',
          relationship: { representative: true },
        },
      ],
    },
  });
  assert.equal(account.accountReference, PERSON);
});

test('naming an account needs a whole name and a real reference; nothing is sent otherwise', async () => {
  const { provider, calls } = fake([]);
  for (const input of [
    { accountReference: PERSON, legalName: { first: '', last: 'Okafor' } },
    { accountReference: 'acct:bad', legalName: { first: 'Ada', last: 'O' } },
  ])
    await assert.rejects(
      provider.nameReceiveOnlyPerson({
        ...input,
        idempotencyKey: `tipme-collect-name-${TIP}`,
      }),
    );
  assert.equal(calls.length, 0);
});

test('a person account is made to hold naira with holdLocalCurrency (P12)', async () => {
  const usdOnly = body('individual-account-named');
  assert.deepEqual(usdOnly.balance_currencies, ['USD']);
  const { provider, calls } = fake([
    jsonResponse(usdOnly),
    // The update's answer: NGN now held as well.
    jsonResponse({ ...usdOnly, balance_currencies: ['USD', 'NGN'] }),
  ]);
  const account = await provider.holdLocalCurrency(PERSON);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].path, `/v1/accounts/${PERSON}`);
  assert.deepEqual(calls[1].body, { balance_currencies: { NGN: true } });
  assert.equal(account.holdsLocalCurrency, true);
});

test('a collect transfer names the account, the key as group, and the exact amount', async () => {
  const { provider, calls } = fake([answer('transfer-paid', 201)]);
  assert.deepEqual(await provider.sendCollectTransfer(collectTransfer), {
    transferRef: 'tr_c0llect7f2a4c7da91d43f7',
    status: 'paid',
  });
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/transfers');
  // As the platform: TipMe's balance is the debited side.
  assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);
  assert.equal(call.headers['Idempotency-Key'], KEY);
  assert.deepEqual(call.body, {
    destination: PERSON,
    amount: '9500.00',
    currency: 'NGN',
    description: 'TipMe tip',
    transfer_group: KEY,
  });
});

test('a collect transfer answering another destination, amount or currency is uncertain', async () => {
  for (const over of [
    { destination: 'acct_someoneElse' },
    { amount: '95.00' },
    { currency: 'USD' },
  ]) {
    const { provider } = fake([
      jsonResponse({ ...body('transfer-paid'), ...over }, 201),
    ]);
    await assert.rejects(
      provider.sendCollectTransfer(collectTransfer),
      (error) =>
        error instanceof UncertainProviderOutcomeError &&
        error.diagnostic?.cause === 'unexpected_state',
    );
  }
});

test('collect transfer refusals are told apart', async () => {
  for (const [name, reason, code, status] of [
    ['refusal-insufficient', 'insufficient', 'INSUFFICIENT_BALANCE', 400],
    ['refusal-forbidden', 'capability', 'FORBIDDEN', 403],
    ['refusal-in-debt', 'in_debt', 'ORGANIZATION_IN_DEBT', 400],
    ['refusal-not-found', 'not_found', 'NOT_FOUND', 404],
  ]) {
    assert.equal(fixture(name)._status, status);
    const { provider } = fake([answer(name)]);
    await assert.rejects(
      provider.sendCollectTransfer(collectTransfer),
      (error) =>
        error instanceof CollectTransferRefusedError &&
        error.reason === reason &&
        error.providerCode === code,
      name,
    );
  }
  for (const failure of [
    jsonResponse({ error_code: 'INTERNAL_SERVER_ERROR' }, 502),
    jsonResponse({ error_code: 'INTERNAL_SERVER_ERROR' }, 500),
    new TypeError('fetch failed'),
    new DOMException('The operation timed out.', 'TimeoutError'),
  ]) {
    const { provider } = fake([failure]);
    await assert.rejects(
      provider.sendCollectTransfer(collectTransfer),
      UncertainProviderOutcomeError,
    );
  }
});

test('a collect transfer refused for TipMe’s key is the platform’s, not the recipient’s', async () => {
  const { provider } = fake([
    jsonResponse(
      { detail: 'Invalid API key', error_code: 'UNAUTHORIZED' },
      401,
    ),
  ]);
  await assert.rejects(
    provider.sendCollectTransfer(collectTransfer),
    (error) =>
      error instanceof PlatformRefusalError && error.refusal === 'provider_key',
  );
});

test('a collect transfer with bad input never reaches the partner', async () => {
  const { provider, calls } = fake([]);
  for (const bad of [
    { amountMinor: 0n },
    { amountMinor: -1n },
    { currency: 'USD' },
    { accountRef: 'a b' },
    { idempotencyKey: 'not a key' },
  ])
    await assert.rejects(
      provider.sendCollectTransfer({ ...collectTransfer, ...bad }),
      (error) => error.name === 'BachsRequestNotSentError',
    );
  assert.equal(calls.length, 0);
});

test("option B's transfer refusals are unchanged", async () => {
  const input = {
    accountRef: 'acct_kLWx4FJ5z2dExsvz',
    amountMinor: 180000n,
    currency: 'NGN',
    idempotencyKey: 'tipme-share-in-0193f7a2-0000-7000-8000-00000000beef',
    description: 'TipMe business share',
  };
  for (const code of ['INSUFFICIENT_BALANCE', 'ORGANIZATION_IN_DEBT']) {
    const { provider } = fake([jsonResponse({ error_code: code }, 400)]);
    await assert.rejects(
      provider.transferToAccount(input),
      (error) =>
        error instanceof PlatformRefusalError &&
        error.refusal === 'reserve_empty' &&
        error.providerCode === code,
    );
  }
  // FORBIDDEN stays TipMe's key on option B; only You collect reads it as the capability.
  const forbidden = fake([answer('refusal-forbidden')]);
  await assert.rejects(
    forbidden.provider.transferToAccount(input),
    (error) =>
      error instanceof PlatformRefusalError && error.refusal === 'provider_key',
  );
});

test('the same key within 24 hours replays the same transfer', async () => {
  const { provider, calls } = fake([
    answer('transfer-paid', 201),
    answer('transfer-replay', 201),
  ]);
  const first = await provider.sendCollectTransfer(collectTransfer);
  const again = await provider.sendCollectTransfer(collectTransfer);
  assert.equal(first.transferRef, again.transferRef);
  assert.deepEqual(
    calls.map((call) => call.headers['Idempotency-Key']),
    [KEY, KEY],
  );
});

function listed(index, over = {}) {
  return {
    ...body('transfer-paid'),
    id: `tr_${String(index).padStart(6, '0')}`,
    amount: '100.00',
    transfer_group: `tipme-collect-tip-${index}`,
    ...over,
  };
}

function page(items, pagination) {
  const template = body('transfer-list-page');
  return jsonResponse({
    items,
    pagination: {
      ...template.pagination,
      returned: items.length,
      ...pagination,
    },
  });
}

test("the account's transfers are listed across every page, more than 100 (P17)", async () => {
  const all = Array.from({ length: 230 }, (_, index) => listed(index));
  all[7] = listed(7, { status: 'pending', transfer_group: null });
  const { provider, calls } = fake([
    page(all.slice(0, 100), {
      has_more: true,
      next_cursor: 'cur_100',
      total: 230,
    }),
    page(all.slice(100, 200), {
      has_more: true,
      next_cursor: 'cur_200',
      offset: 100,
      total: 230,
    }),
    page(all.slice(200), { has_more: false, offset: 200, total: 230 }),
  ]);
  const transfers = await provider.listAccountTransfers(PERSON);
  assert.equal(transfers.length, 230);
  assert.deepEqual(transfers[0], {
    transferRef: 'tr_000000',
    status: 'paid',
    amountMinor: 10000n,
    currency: 'NGN',
    group: 'tipme-collect-tip-0',
  });
  assert.equal(transfers[7].status, 'pending');
  assert.equal(transfers[7].group, null);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      // The first page is option B's read-back request exactly.
      `/v1/transfers?connected_account_id=${PERSON}&limit=100`,
      `/v1/transfers?connected_account_id=${PERSON}&limit=100&cursor=cur_100`,
      `/v1/transfers?connected_account_id=${PERSON}&limit=100&cursor=cur_200`,
    ],
  );
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);
  }
});

test('a transfer seen twice across pages (one landed meanwhile) is listed once', async () => {
  const first = Array.from({ length: 100 }, (_, index) => listed(index + 1));
  const { provider } = fake([
    page(first, { has_more: true, next_cursor: 'cur_100', total: 101 }),
    // A new transfer at the head pushed tr_000100 onto the next page too.
    page([listed(100), listed(101)], { has_more: false, total: 102 }),
  ]);
  const transfers = await provider.listAccountTransfers(PERSON);
  assert.equal(transfers.length, 101);
  assert.equal(new Set(transfers.map((t) => t.transferRef)).size, 101);
});

test('a listing whose pagination fails or disagrees is uncertain', async () => {
  const full = Array.from({ length: 100 }, (_, index) => listed(index));
  const cases = [
    // A full page with no way to ask for the next.
    [jsonResponse({ items: full })],
    // More promised, but no cursor.
    [page(full, { has_more: true, next_cursor: null })],
    // The same cursor twice: a loop.
    [
      page(full, { has_more: true, next_cursor: 'cur_100' }),
      page([listed(500)], { has_more: true, next_cursor: 'cur_100' }),
    ],
    // More promised, nothing given.
    [page([], { has_more: true, next_cursor: 'cur_0' })],
    // Fewer transfers than the total said: some were skipped.
    [page([listed(1)], { has_more: false, total: 3 })],
    // One transfer listed twice with different money.
    [
      page(full, { has_more: true, next_cursor: 'cur_100' }),
      page([listed(99, { amount: '5.00' })], { has_more: false }),
    ],
    // A page that fails to read.
    [
      page(full, { has_more: true, next_cursor: 'cur_100' }),
      jsonResponse({ error_code: 'INTERNAL_SERVER_ERROR' }, 503),
    ],
    [
      page(full, { has_more: true, next_cursor: 'cur_100' }),
      new TypeError('fetch failed'),
    ],
    // An amount that can't be read.
    [page([listed(1, { amount: 'ten' })], { has_more: false })],
  ];
  for (const [index, answers] of cases.entries()) {
    const { provider } = fake(answers);
    await assert.rejects(
      provider.listAccountTransfers(PERSON),
      UncertainProviderOutcomeError,
      `case ${index}`,
    );
  }
});

test('a short listing with no pagination block is the whole list', async () => {
  const { provider } = fake([jsonResponse({ items: [listed(1), listed(2)] })]);
  assert.equal((await provider.listAccountTransfers(PERSON)).length, 2);
});

test('platform balances are signed and list every currency', async () => {
  const { provider, calls } = fake([answer('balances-usd-negative')]);
  assert.deepEqual(await provider.platformBalances(), [
    { currency: 'NGN', availableMinor: 48250000n, pendingMinor: 12500000n },
    { currency: 'USD', availableMinor: -1500n, pendingMinor: 0n },
  ]);
  const [call] = calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/v1/balances');
  assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);
});

test('a crypto bucket is skipped with a note, and NGN and USD are still returned', async () => {
  const notes = [];
  const { provider } = fake(
    [
      jsonResponse({
        ...body('balances-usd-negative'),
        balances: [
          ...body('balances-usd-negative').balances,
          {
            currency: 'USDT_TRC20',
            available_balance: '12.345678',
            pending_balance: '0.000000',
          },
        ],
      }),
    ],
    { onNote: (message, fields) => notes.push({ message, fields }) },
  );
  assert.deepEqual(await provider.platformBalances(), [
    { currency: 'NGN', availableMinor: 48250000n, pendingMinor: 12500000n },
    { currency: 'USD', availableMinor: -1500n, pendingMinor: 0n },
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].fields.currency, 'USDT_TRC20');
  // Never the amount: only the currency and that it was skipped.
  assert.equal(JSON.stringify(notes).includes('12.345678'), false);
});

test('a negative crypto bucket is flagged: it blocks every transfer', async () => {
  for (const available of ['-3.500000', '-0.000001']) {
    const { provider } = fake([
      jsonResponse({
        balances: [
          {
            currency: 'NGN',
            available_balance: '100.00',
            pending_balance: '0.00',
          },
          {
            currency: 'USDT_TRC20',
            available_balance: available,
            pending_balance: '0.000000',
          },
        ],
      }),
    ]);
    await assert.rejects(
      provider.platformBalances(),
      (error) =>
        error instanceof UnlistedNegativeBalanceError &&
        error.currency === 'USDT_TRC20',
    );
  }
  // A zero crypto bucket written with a sign is not negative.
  const zero = fake([
    jsonResponse({
      balances: [
        {
          currency: 'USDT_TRC20',
          available_balance: '-0.00',
          pending_balance: '0',
        },
      ],
    }),
  ]);
  assert.deepEqual(await zero.provider.platformBalances(), []);
});

test('an unreadable platform balance is an error, never a zero', async () => {
  for (const bad of ['-', '1.001', 'abc', '--1.00', '-0.5x']) {
    const { provider } = fake([
      jsonResponse({
        balances: [
          { currency: 'NGN', available_balance: bad, pending_balance: '0.00' },
        ],
      }),
    ]);
    await assert.rejects(provider.platformBalances(), (error) =>
      ['BachsProtocolError'].includes(error.name),
    );
  }
});

test('the NGN balance used for withdrawals still clamps a negative to zero', async () => {
  const { provider } = fake([answer('balances-usd-negative')]);
  assert.deepEqual(await provider.platformBalance('NGN'), {
    availableMinor: 48250000n,
  });
  const negative = fake([
    jsonResponse({
      balances: [
        {
          currency: 'NGN',
          available_balance: '-20.00',
          pending_balance: '0.00',
        },
      ],
    }),
  ]);
  assert.deepEqual(await negative.provider.platformBalance('NGN'), {
    availableMinor: 0n,
  });
});

test('the platform payout schedule is read without an account header', async () => {
  const { provider, calls } = fake([answer('balance-settings')]);
  assert.deepEqual(await provider.platformPayoutSchedule(), {
    NGN: 'manual',
    USD: 'daily',
  });
  const [call] = calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/v1/balance_settings');
  assert.equal(Object.hasOwn(call.headers, 'X-Account-Id'), false);
});

test('collect checkout passes the methods through', async () => {
  const { provider, calls } = fake([answer('checkout-created', 201)]);
  await provider.initializeCollectCheckout({
    ...collectCheckout,
    paymentMethods: ['bank_transfer'],
  });
  assert.deepEqual(calls[0].body.payment_method_types, ['NGN_BANK_TRANSFER']);
});

test('an empty or unknown collect method list never reaches Bachs', async () => {
  for (const paymentMethods of [[], ['crypto']]) {
    const { provider, calls } = fake([]);
    await assert.rejects(
      provider.initializeCollectCheckout({
        ...collectCheckout,
        paymentMethods,
      }),
      BachsRequestNotSentError,
    );
    assert.equal(calls.length, 0);
  }
});

test('a repeated collect method never reaches Bachs', async () => {
  const { provider, calls } = fake([]);
  await assert.rejects(
    provider.initializeCollectCheckout({
      ...collectCheckout,
      paymentMethods: ['card', 'card'],
    }),
    BachsRequestNotSentError,
  );
  assert.equal(calls.length, 0);
});
