import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  PayoutRejectedError,
  UncertainProviderOutcomeError,
  createBachsProvider,
} from '../dist/index.js';

const ACCOUNT = 'acct_3Wq8ZfT1yHnJ5sVe';
const ACCOUNT_NUMBER = '0123456789';
const SECRET = 'current-secret-0123456789';
const NOW = new Date('2026-11-01T12:00:00.000Z');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records every request. Nothing here can reach a real origin: fetch is always this fake. */
function fake(answer) {
  const calls = [];
  const provider = createBachsProvider({
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: [SECRET],
    fetchImpl: async (url, init) => {
      const call = {
        method: init.method,
        path: `${url.pathname}${url.search}`,
        origin: url.origin,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(call);
      return typeof answer === 'function' ? answer(call) : answer;
    },
  });
  return { provider, calls };
}

const payoutBody = (overrides = {}) => ({
  id: 'pay_4Xr9dLc0mNv7Kq2B',
  status: 'pending',
  amount: '1500.00',
  currency: 'NGN',
  source_currency: 'NGN',
  fee: '50.00',
  total_debited: '1550.00',
  destination: 'pd_7Kq2',
  reference: 'p1',
  failure_reason: null,
  ...overrides,
});

// What a read reports about payoutBody(), to compare with what was asked for.
const readDetails = {
  feeMinor: 5000n,
  amountMinor: 150000n,
  currency: 'NGN',
  destinationRef: 'pd_7Kq2',
  operationReference: 'p1',
};

const payoutInput = {
  payoutId: 'p1',
  accountRef: ACCOUNT,
  destinationRef: 'pd_7Kq2',
  amountMinor: 150000n,
  currency: 'NGN',
  idempotencyKey: 'payout.p1',
};
const feeInput = {
  accountRef: ACCOUNT,
  feeMinor: 5000n,
  currency: 'NGN',
  idempotencyKey: 'payout-fee.p1',
};
const transferBody = {
  id: 'tr_8c1e',
  source: 'acct_platform',
  destination: ACCOUNT,
  amount: '50.00',
  currency: 'NGN',
  status: 'paid',
};
const bank = {
  accountNumber: ACCOUNT_NUMBER,
  accountName: 'ADA OKAFOR',
  bankCode: '058',
};

test('a payout posts the exact decimal amount with the account and payout.<id> key', async () => {
  const { provider, calls } = fake(jsonResponse(payoutBody(), 200));
  const result = await provider.initiatePayout(payoutInput);

  assert.deepEqual(result, {
    providerReference: `${ACCOUNT}:pay_4Xr9dLc0mNv7Kq2B`,
    status: 'pending',
    // `total_debited` less the amount: the fee actually charged.
    feeMinor: 5000n,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/v1/payouts');
  assert.equal(calls[0].origin, 'https://sandbox-api.bachs.io');
  assert.equal(calls[0].headers['X-Account-Id'], ACCOUNT);
  assert.equal(calls[0].headers['Idempotency-Key'], 'payout.p1');
  assert.deepEqual(calls[0].body, {
    destination: 'pd_7Kq2',
    amount: '1500.00',
    reference: 'p1',
    // Without one, the recipient's bank statement would name the provider.
    narration: 'TipMe payout',
  });
});

test('the fee transfer moves 50.00 NGN to the account with payout-fee.<id>', async () => {
  const { provider, calls } = fake(jsonResponse(transferBody, 201));
  assert.deepEqual(await provider.coverPayoutFee(feeInput), {
    transferRef: 'tr_8c1e',
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/v1/transfers');
  assert.equal(calls[0].headers['Idempotency-Key'], 'payout-fee.p1');
  // The platform is the debited side, so the request does not act as the account.
  assert.equal(calls[0].headers['X-Account-Id'], undefined);
  assert.equal(calls[0].body.destination, ACCOUNT);
  assert.equal(calls[0].body.amount, '50.00');
  assert.equal(calls[0].body.currency, 'NGN');
});

test('the payout fee quote is the flat 50 NGN, marked as not exact', async () => {
  const { provider, calls } = fake(jsonResponse({}));
  assert.deepEqual(await provider.quotePayoutFee(ACCOUNT, 150000n, 'NGN'), {
    feeMinor: 5000n,
    exact: false,
  });
  assert.equal(calls.length, 0);
});

test('payout statuses map pending, processing, completed, failed and review', async () => {
  const cases = [
    ['pending', { status: 'pending' }],
    ['processing', { status: 'pending' }],
    ['completed', { status: 'paid' }],
    ['failed', { status: 'failed', failureReason: 'other' }],
    ['review', { status: 'review' }],
    // A status TipMe does not know is never read as an outcome.
    ['something_new', { status: 'review' }],
  ];
  for (const [status, expected] of cases) {
    const { provider, calls } = fake(jsonResponse(payoutBody({ status })));
    assert.deepEqual(await provider.fetchPayoutStatus(`${ACCOUNT}:pay_1`), {
      ...expected,
      ...readDetails,
    });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/v1/payouts/pay_1');
    assert.equal(calls[0].headers['X-Account-Id'], ACCOUNT);
  }

  const started = [
    ['pending', 'pending'],
    ['processing', 'processing'],
    ['review', 'review'],
    ['something_new', 'review'],
  ];
  for (const [status, expected] of started) {
    const { provider } = fake(jsonResponse(payoutBody({ status })));
    assert.equal((await provider.initiatePayout(payoutInput)).status, expected);
  }

  const missing = fake(jsonResponse({ error_code: 'NOT_FOUND' }, 404));
  assert.deepEqual(
    await missing.provider.fetchPayoutStatus(`${ACCOUNT}:pay_1`),
    {
      status: 'not_found',
    },
  );
});

test('a failed payout names only an allowlisted reason, never the provider text', async () => {
  const cases = [
    ['Account ORGANIZATION_IN_DEBT', 'in_debt'],
    ['Destination bank rejected the account', 'destination'],
    ['Insufficient account balance', 'other'],
    ['Invalid account number', 'destination'],
    ['Something else went wrong', 'other'],
  ];
  for (const [failure_reason, failureReason] of cases) {
    const { provider } = fake(
      jsonResponse(payoutBody({ status: 'failed', failure_reason })),
    );
    assert.deepEqual(await provider.fetchPayoutStatus(`${ACCOUNT}:pay_1`), {
      status: 'failed',
      failureReason,
      ...readDetails,
    });
  }
});

test('an unreadable or missing total_debited reports no fee, and does not lose the payout', async () => {
  for (const total_debited of [undefined, null, 'lots', '1400.00']) {
    const { provider } = fake(jsonResponse(payoutBody({ total_debited }), 200));
    const result = await provider.initiatePayout(payoutInput);
    assert.equal(result.feeMinor, undefined, String(total_debited));
    assert.equal(result.status, 'pending');
  }
});

test('ORGANIZATION_IN_DEBT is a definite failure with reason in_debt', async () => {
  const { provider } = fake(
    jsonResponse(
      { detail: 'negative', error_code: 'ORGANIZATION_IN_DEBT' },
      400,
    ),
  );
  await assert.rejects(provider.initiatePayout(payoutInput), (error) => {
    assert.ok(error instanceof PayoutRejectedError);
    assert.equal(error.failureReason, 'in_debt');
    assert.doesNotMatch(error.message, /bachs/i);
    return true;
  });
});

test('destination refusals are definite failures with reason destination', async () => {
  for (const code of ['DESTINATION_REJECTED', 'DESTINATION_PENDING_REVIEW']) {
    const { provider } = fake(jsonResponse({ error_code: code }, 400));
    await assert.rejects(
      provider.initiatePayout(payoutInput),
      (error) =>
        error instanceof PayoutRejectedError &&
        error.failureReason === 'destination',
    );
  }
});

test('a platform in debt fails the fee transfer without blaming the recipient', async () => {
  // On a transfer the debt is the platform's own, so it must not pause the recipient.
  const { provider } = fake(
    jsonResponse({ error_code: 'ORGANIZATION_IN_DEBT' }, 400),
  );
  await assert.rejects(
    provider.coverPayoutFee(feeInput),
    (error) =>
      error instanceof PayoutRejectedError && error.failureReason === 'other',
  );
});

test('a timeout on a payout or transfer is uncertain, never a failure', async () => {
  const timedOut = () => {
    throw new DOMException('timed out', 'TimeoutError');
  };
  const writes = (provider) => [
    () => provider.initiatePayout(payoutInput),
    () => provider.coverPayoutFee(feeInput),
  ];
  for (const answer of [
    timedOut,
    () => jsonResponse({ error_code: 'INTERNAL_SERVER_ERROR' }, 500),
    () => jsonResponse({ error_code: 'BAD_GATEWAY' }, 502),
    () => jsonResponse({ error_code: 'IDEMPOTENCY_IN_PROGRESS' }, 409),
    () => jsonResponse({ error_code: 'TOO_MANY_REQUESTS' }, 429),
    // "Reference already exists": an earlier attempt really did create this payout.
    () => jsonResponse({ error_code: 'BAD_REQUEST' }, 400),
    () => new Response('not json', { status: 200 }),
    () => jsonResponse({ unexpected: true }, 200),
  ]) {
    const { provider } = fake(answer);
    for (const write of writes(provider)) {
      await assert.rejects(write(), (error) => {
        assert.ok(error instanceof UncertainProviderOutcomeError);
        assert.doesNotMatch(error.message, /bachs/i);
        return true;
      });
    }
  }
});

test('a payout answer for other money or another destination is uncertain', async () => {
  for (const body of [
    payoutBody({ amount: '1500.01' }),
    payoutBody({ currency: 'USD' }),
    payoutBody({ destination: 'pd_other' }),
  ]) {
    const { provider } = fake(jsonResponse(body));
    await assert.rejects(
      provider.initiatePayout(payoutInput),
      UncertainProviderOutcomeError,
    );
  }
  const { provider } = fake(jsonResponse({ ...transferBody, amount: '5.00' }));
  await assert.rejects(
    provider.coverPayoutFee(feeInput),
    UncertainProviderOutcomeError,
  );
});

test('money writes are refused before sending when the input is wrong', async () => {
  const { provider, calls } = fake(jsonResponse(payoutBody()));
  for (const input of [
    { ...payoutInput, amountMinor: 0n },
    { ...payoutInput, amountMinor: -1n },
    { ...payoutInput, accountRef: 'bad:ref' },
    { ...payoutInput, idempotencyKey: '' },
    { ...payoutInput, payoutId: 'has space' },
    { ...payoutInput, currency: 'USD' },
  ]) {
    await assert.rejects(provider.initiatePayout(input));
  }
  await assert.rejects(provider.coverPayoutFee({ ...feeInput, feeMinor: 0n }));
  await assert.rejects(
    provider.coverPayoutFee({ ...feeInput, idempotencyKey: '' }),
  );
  assert.equal(calls.length, 0);
});

test('balances read available_balance for the account and for the platform', async () => {
  const body = {
    account_id: 'x',
    balances: [
      { currency: 'USD', available_balance: '1.00', pending_balance: '0.00' },
      {
        currency: 'NGN',
        available_balance: '4825.50',
        pending_balance: '1250.00',
      },
    ],
  };
  const { provider, calls } = fake(() => jsonResponse(body));
  assert.deepEqual(await provider.payoutBalance(ACCOUNT, 'NGN'), {
    availableMinor: 482550n,
  });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/v1/balances');
  assert.equal(calls[0].headers['X-Account-Id'], ACCOUNT);

  assert.deepEqual(await provider.platformBalance('NGN'), {
    availableMinor: 482550n,
  });
  assert.equal(calls[1].path, '/v1/balances');
  assert.equal(calls[1].headers['X-Account-Id'], undefined);
});

test('a currency absent from balances is zero, and a negative balance is nothing to spend', async () => {
  const absent = fake(jsonResponse({ balances: [] }));
  assert.deepEqual(await absent.provider.payoutBalance(ACCOUNT, 'NGN'), {
    availableMinor: 0n,
  });
  const negative = fake(
    jsonResponse({
      balances: [{ currency: 'NGN', available_balance: '-20.00' }],
    }),
  );
  assert.deepEqual(await negative.provider.payoutBalance(ACCOUNT, 'NGN'), {
    availableMinor: 0n,
  });
  const invalid = fake(
    jsonResponse({
      balances: [{ currency: 'NGN', available_balance: '1.001' }],
    }),
  );
  await assert.rejects(invalid.provider.payoutBalance(ACCOUNT, 'NGN'));
});

test('manual payouts post interval manual for the account', async () => {
  const { provider, calls } = fake(
    jsonResponse({
      schedule_by_currency: { NGN: { currency: 'NGN', interval: 'manual' } },
    }),
  );
  await provider.setManualPayouts(ACCOUNT);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/v1/balance_settings');
  assert.equal(calls[0].headers['X-Account-Id'], ACCOUNT);
  assert.ok(calls[0].headers['Idempotency-Key']);
  assert.deepEqual(calls[0].body, {
    schedule_by_currency: { NGN: { interval: 'manual' } },
  });

  const other = fake(
    jsonResponse({ schedule_by_currency: { NGN: { interval: 'daily' } } }),
  );
  await assert.rejects(
    other.provider.setManualPayouts(ACCOUNT),
    UncertainProviderOutcomeError,
  );
});

test('destination statuses map to usable, pending_review and rejected', async () => {
  const cases = [
    [{ status: 'approved', is_usable: true }, 'usable', true],
    [{ status: 'pending_review', is_usable: false }, 'pending_review', false],
    [{ status: 'rejected', is_usable: false }, 'rejected', false],
    // Approved but deactivated: not payable.
    [{ status: 'approved', is_usable: false }, 'pending_review', false],
    [{ status: 'something_new', is_usable: true }, 'pending_review', false],
  ];
  for (const [answer, status, usable] of cases) {
    const { provider, calls } = fake(
      jsonResponse(
        {
          id: 'pd_1',
          name: 'x',
          type: 'bank_account',
          currency: 'NGN',
          account_number: ACCOUNT_NUMBER,
          ...answer,
        },
        201,
      ),
    );
    assert.deepEqual(await provider.addPayoutDestination(ACCOUNT, bank), {
      destinationRef: 'pd_1',
      usable,
      status,
    });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/v1/payouts/destinations');
    assert.equal(calls[0].headers['X-Account-Id'], ACCOUNT);
    assert.deepEqual(calls[0].body, {
      type: 'bank_account',
      currency: 'NGN',
      bank_code: '058',
      account_number: ACCOUNT_NUMBER,
      account_name: 'ADA OKAFOR',
    });
  }
});

test('a destination retry keeps its key, and the key does not reveal the account number', async () => {
  const answer = () =>
    jsonResponse({ id: 'pd_1', status: 'approved', is_usable: true }, 201);
  const { provider, calls } = fake(answer);
  await provider.addPayoutDestination(ACCOUNT, bank);
  await provider.addPayoutDestination(ACCOUNT, bank);
  await provider.addPayoutDestination(ACCOUNT, {
    ...bank,
    accountNumber: '9876543210',
  });
  const [first, retry, other] = calls.map(
    (call) => call.headers['Idempotency-Key'],
  );
  assert.ok(first);
  assert.equal(first, retry);
  assert.notEqual(first, other);
  assert.doesNotMatch(first, new RegExp(ACCOUNT_NUMBER));
});

test('reading a destination asks for it on the account, and is_usable decides', async () => {
  for (const [answer, status] of [
    [{ id: 'pd_1', status: 'approved', is_usable: true }, 'usable'],
    [{ id: 'pd_1', status: 'approved', is_usable: false }, 'pending_review'],
    [
      { id: 'pd_1', status: 'pending_review', is_usable: false },
      'pending_review',
    ],
    [{ id: 'pd_1', status: 'rejected', is_usable: false }, 'rejected'],
  ]) {
    const { provider, calls } = fake(jsonResponse(answer));
    assert.equal(
      await provider.payoutDestinationStatus(ACCOUNT, 'pd_1'),
      status,
    );
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/v1/payouts/destinations/pd_1');
    assert.equal(calls[0].headers['X-Account-Id'], ACCOUNT);
  }
});

test('a destination the provider no longer has is unusable; an outage is not an answer', async () => {
  const gone = fake(jsonResponse({ detail: 'Not found' }, 404));
  assert.equal(
    await gone.provider.payoutDestinationStatus(ACCOUNT, 'pd_1'),
    'rejected',
  );
  const down = fake(jsonResponse({ detail: 'Oops' }, 500));
  await assert.rejects(down.provider.payoutDestinationStatus(ACCOUNT, 'pd_1'));
});

test('the bank list comes from the reference endpoint', async () => {
  const { provider, calls } = fake(
    jsonResponse({
      country: 'NG',
      banks: [
        { name: 'Providus Bank', code: '101' },
        { name: 'Sterling Bank', code: '232' },
      ],
    }),
  );
  assert.deepEqual(await provider.listBanks('NG'), [
    { code: '101', name: 'Providus Bank' },
    { code: '232', name: 'Sterling Bank' },
  ]);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/v1/reference/banks?country=NG');
});

test('an account number resolves to its name, or to null when it does not match', async () => {
  const { provider, calls } = fake(
    jsonResponse({
      resolved: true,
      account_name: 'ADA OKAFOR',
      account_number: ACCOUNT_NUMBER,
      message: null,
    }),
  );
  assert.deepEqual(
    await provider.resolveBankAccount({
      accountNumber: ACCOUNT_NUMBER,
      bankCode: '058',
    }),
    { accountName: 'ADA OKAFOR' },
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/v1/misc/bank-accounts/resolve');
  assert.deepEqual(calls[0].body, {
    account_number: ACCOUNT_NUMBER,
    bank_code: '058',
    country: 'NG',
  });

  const unmatched = fake(
    jsonResponse({
      resolved: false,
      account_name: null,
      account_number: null,
      message: 'No match',
    }),
  );
  assert.equal(
    await unmatched.provider.resolveBankAccount({
      accountNumber: ACCOUNT_NUMBER,
      bankCode: '058',
    }),
    null,
  );
});

test('the payout capability needs both payouts and transfers active', async () => {
  const status = (value) => (value ? { status: value } : undefined);
  const cases = [
    ['active', 'active', 'active'],
    ['active', 'restricted', 'restricted'],
    ['restricted', 'active', 'restricted'],
    ['pending', 'active', 'restricted'],
    ['active', undefined, 'missing'],
    [undefined, 'active', 'missing'],
    ['unrequested', 'active', 'missing'],
    [undefined, undefined, 'missing'],
  ];
  for (const [payouts, transfers, expected] of cases) {
    const { provider, calls } = fake(
      jsonResponse({
        id: ACCOUNT,
        capabilities: {
          payouts: status(payouts),
          transfers: status(transfers),
        },
        requirements: { currently_due: ['payout_destination'] },
      }),
    );
    assert.deepEqual(await provider.payoutCapability(ACCOUNT), {
      status: expected,
      requirementsDue: ['payout_destination'],
    });
    assert.equal(calls[0].path, `/v1/accounts/${ACCOUNT}`);
  }
  const gone = fake(jsonResponse({ error_code: 'NOT_FOUND' }, 404));
  assert.deepEqual(await gone.provider.payoutCapability(ACCOUNT), {
    status: 'missing',
    requirementsDue: [],
  });
});

test('requirements due name only what blocks payouts or transfers', async () => {
  const { provider } = fake(
    jsonResponse({
      id: ACCOUNT,
      capabilities: { payouts: { status: 'restricted' } },
      requirements: {
        currently_due: ['payout_destination', 'business_profile.url'],
        entries: [
          {
            field: 'payout_destination',
            status: 'currently_due',
            restricts_capabilities: ['payouts'],
          },
          {
            field: 'persons.name',
            status: 'past_due',
            restricts_capabilities: ['transfers'],
          },
          {
            field: 'business_profile.url',
            status: 'currently_due',
            restricts_capabilities: ['ngn_card_collection'],
          },
          {
            field: 'persons.id_number',
            status: 'pending_verification',
            restricts_capabilities: ['payouts'],
          },
        ],
      },
    }),
  );
  assert.deepEqual((await provider.payoutCapability(ACCOUNT)).requirementsDue, [
    'payout_destination',
    'persons.name',
  ]);
});

test('an existing account can ask for the payout capabilities', async () => {
  const { provider, calls } = fake(
    jsonResponse({ id: ACCOUNT, capabilities: {} }),
  );
  await provider.requestPayoutCapabilities(ACCOUNT);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `/v1/accounts/${ACCOUNT}`);
  assert.deepEqual(calls[0].body, {
    configuration: {
      recipient: {
        capabilities: {
          payouts: { requested: true },
          transfers: { requested: true },
        },
      },
    },
  });
  // The account object's write is not the account acting: it names the account in the path.
  assert.equal(calls[0].headers['X-Account-Id'], undefined);
  assert.equal(
    calls[0].headers['Idempotency-Key'],
    `payout-capabilities.${ACCOUNT}`,
  );

  const timedOut = fake(() => {
    throw new DOMException('timed out', 'TimeoutError');
  });
  await assert.rejects(
    timedOut.provider.requestPayoutCapabilities(ACCOUNT),
    UncertainProviderOutcomeError,
  );
});

test('a payout is found by its reference, scoped to its account', async () => {
  const cases = [
    ['pending', { status: 'pending' }],
    ['processing', { status: 'pending' }],
    ['completed', { status: 'paid' }],
    ['failed', { status: 'failed', failureReason: 'in_debt' }],
    ['something_new', { status: 'review' }],
  ];
  for (const [status, expected] of cases) {
    const { provider, calls } = fake(
      jsonResponse({
        total: 1,
        items: [
          payoutBody({
            status,
            ...(status === 'failed'
              ? { failure_reason: 'ORGANIZATION_IN_DEBT' }
              : {}),
          }),
        ],
      }),
    );
    assert.deepEqual(await provider.findPayoutByReference(ACCOUNT, 'p1'), {
      providerReference: `${ACCOUNT}:pay_4Xr9dLc0mNv7Kq2B`,
      ...expected,
      ...readDetails,
    });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/v1/payouts?reference=p1');
    // Without it Bachs searches the platform's payouts and truthfully finds nothing.
    assert.equal(calls[0].headers['X-Account-Id'], ACCOUNT);
    assert.equal(calls[0].headers['Idempotency-Key'], undefined);
  }
});

test('only a definite empty answer means no payout exists', async () => {
  const { provider } = fake(jsonResponse({ total: 0, items: [] }));
  assert.equal(await provider.findPayoutByReference(ACCOUNT, 'p1'), null);
});

test('more than one match is its own error, so it can raise an alarm', async () => {
  const { provider } = fake(
    jsonResponse({
      total: 2,
      items: [payoutBody(), payoutBody({ id: 'pay_2' })],
    }),
  );
  await assert.rejects(provider.findPayoutByReference(ACCOUNT, 'p1'), {
    name: 'AmbiguousPayoutError',
  });
});

test('reads carry amount, currency and destination; an unreadable amount is no answer', async () => {
  const { provider } = fake(jsonResponse(payoutBody()));
  const read = await provider.fetchPayoutStatus(`${ACCOUNT}:pay_1`);
  assert.equal(read.amountMinor, 150000n);
  assert.equal(read.currency, 'NGN');
  assert.equal(read.destinationRef, 'pd_7Kq2');
  assert.equal(read.operationReference, 'p1');
  const unnamed = fake(jsonResponse(payoutBody({ reference: null })));
  assert.equal(
    (await unnamed.provider.fetchPayoutStatus(`${ACCOUNT}:pay_1`))
      .operationReference,
    undefined,
  );
  const foreign = fake(jsonResponse(payoutBody({ currency: 'USD' })));
  const other = await foreign.provider.fetchPayoutStatus(`${ACCOUNT}:pay_1`);
  assert.equal(other.currency, 'USD');
  assert.equal(other.amountMinor, undefined);
  const bad = fake(jsonResponse(payoutBody({ amount: 'lots' })));
  await assert.rejects(bad.provider.fetchPayoutStatus(`${ACCOUNT}:pay_1`));
});

test('a payout event carries its amount, currency, reference and fee', () => {
  const { event } = verify(
    payoutEvent('payout.paid', { withdrawal_fee: '60.00' }),
  );
  assert.equal(event.amountMinor, 150000n);
  assert.equal(event.currency, 'NGN');
  assert.equal(event.operationReference, 'p1');
  assert.equal(event.feeMinor, 6000n);
  assert.equal(event.contradicted, undefined);
  const foreign = verify(payoutEvent('payout.paid', { currency: 'USD' })).event;
  assert.equal(foreign.currency, 'USD');
  assert.equal(foreign.amountMinor, undefined);
  for (const amount of ['lots', undefined])
    assert.equal(
      verify(payoutEvent('payout.paid', { amount })).event.contradicted,
      true,
    );
});

test('more than one match is uncertain, never a pick', async () => {
  for (const body of [
    { total: 2, items: [payoutBody(), payoutBody({ id: 'pay_2' })] },
    { total: 2, items: [payoutBody()] },
    { items: [payoutBody(), payoutBody({ id: 'pay_2' })] },
  ]) {
    const { provider } = fake(jsonResponse(body));
    await assert.rejects(
      provider.findPayoutByReference(ACCOUNT, 'p1'),
      UncertainProviderOutcomeError,
    );
  }
});

test('anything but a clear answer from the lookup is uncertain', async () => {
  for (const answer of [
    () => {
      throw new DOMException('timed out', 'TimeoutError');
    },
    () => {
      throw new TypeError('fetch failed');
    },
    () => jsonResponse({ error_code: 'INTERNAL_SERVER_ERROR' }, 500),
    () => jsonResponse({ error_code: 'BAD_GATEWAY' }, 502),
    () => jsonResponse({ error_code: 'NOT_FOUND' }, 404),
    () => jsonResponse({ error_code: 'TOO_MANY_REQUESTS' }, 429),
    () => new Response('not json', { status: 200 }),
    () => jsonResponse({ unexpected: true }),
    // No total: an empty list alone does not prove there is none.
    () => jsonResponse({ items: [] }),
    () => jsonResponse({ items: [], pagination: { total: 0 } }),
    () => jsonResponse({ total: null, items: [] }),
    // Says some exist but lists none.
    () => jsonResponse({ total: 1, items: [] }),
    // Not the payout that was asked about.
    () => jsonResponse({ total: 1, items: [payoutBody({ reference: 'p2' })] }),
    () => jsonResponse({ total: 1, items: [payoutBody({ reference: null })] }),
  ]) {
    const { provider } = fake(answer);
    await assert.rejects(
      provider.findPayoutByReference(ACCOUNT, 'p1'),
      (error) => {
        assert.ok(error instanceof UncertainProviderOutcomeError);
        assert.doesNotMatch(error.message, /bachs/i);
        return true;
      },
    );
  }
});

test('a lookup with a reference Bachs could not hold is refused before sending', async () => {
  const { provider, calls } = fake(jsonResponse({ total: 0, items: [] }));
  await assert.rejects(provider.findPayoutByReference(ACCOUNT, 'has space'));
  await assert.rejects(provider.findPayoutByReference('bad:ref', 'p1'));
  await assert.rejects(
    provider.findPayoutByReference(ACCOUNT, 'x'.repeat(129)),
  );
  assert.equal(calls.length, 0);
});

test('the adapter advertises payouts and keeps its environment name', () => {
  const { provider } = fake(jsonResponse({}));
  assert.equal(provider.capabilities.payouts, true);
  assert.equal(provider.name, 'bachs-sandbox');
});

test('the full account number never appears in an error message', async () => {
  const leaky = {
    detail: `Account ${ACCOUNT_NUMBER} could not be used`,
    error_code: 'BANK_ROUTING_DETAILS_INVALID',
    errors: [{ field: 'account_number', message: ACCOUNT_NUMBER }],
  };
  const answers = [
    () => {
      throw new TypeError(`fetch failed for ${ACCOUNT_NUMBER}`);
    },
    () => jsonResponse(leaky, 400),
    () => jsonResponse(leaky, 500),
    () => jsonResponse({ echoed: ACCOUNT_NUMBER }, 200),
    () => new Response(`not json ${ACCOUNT_NUMBER}`, { status: 200 }),
  ];
  const calls = (provider) => [
    () => provider.addPayoutDestination(ACCOUNT, bank),
    () =>
      provider.resolveBankAccount({
        accountNumber: ACCOUNT_NUMBER,
        bankCode: '058',
      }),
  ];
  let rejections = 0;
  for (const answer of answers) {
    const { provider } = fake(answer);
    for (const call of calls(provider)) {
      await assert.rejects(call(), (error) => {
        rejections += 1;
        const seen = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
        assert.doesNotMatch(seen, new RegExp(ACCOUNT_NUMBER));
        return true;
      });
    }
  }
  assert.equal(rejections, 10);

  // Input TipMe refuses before sending is not echoed either.
  const { provider, calls: sent } = fake(jsonResponse({}));
  await assert.rejects(
    provider.addPayoutDestination(ACCOUNT, {
      ...bank,
      accountNumber: '01234567890123',
    }),
    (error) => !error.message.includes('01234567890123'),
  );
  assert.equal(sent.length, 0);
});

const sign = (rawBody) => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const digest = createHmac('sha256', SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  return { 'x-bachs-signature-v2': `t=${timestamp},v1=${digest}` };
};

const payoutEvent = (type, data = {}, envelope = {}) => ({
  id: 'evt_1',
  type,
  created_at: '2026-11-01T12:00:00.000000+00:00',
  organization_id: ACCOUNT,
  data: {
    withdrawal_id: 'pay_1',
    reference: 'p1',
    status: type === 'payout.paid' ? 'completed' : 'failed',
    amount: '1500.00',
    currency: 'NGN',
    // As payout-paid.md shows them; the docs do not settle whether `amount` includes the fee.
    withdrawal_fee: '50.00',
    net_from_amount: '1450.00',
    ...data,
  },
  ...envelope,
});

function verify(event) {
  const { provider } = fake(jsonResponse({}));
  const raw = Buffer.from(JSON.stringify(event));
  return provider.verifyWebhook(raw, sign(raw), NOW);
}

test('payout.paid and payout.failed webhooks normalize to payout events', () => {
  assert.deepEqual(verify(payoutEvent('payout.paid')), {
    ok: true,
    event: {
      kind: 'payout',
      eventId: 'evt_1',
      eventType: 'payout.paid',
      providerReference: `${ACCOUNT}:pay_1`,
      accountReference: ACCOUNT,
      status: 'paid',
      currency: 'NGN',
      amountMinor: 150000n,
      feeMinor: 5000n,
      operationReference: 'p1',
    },
  });
  assert.deepEqual(verify(payoutEvent('payout.failed')), {
    ok: true,
    event: {
      kind: 'payout',
      eventId: 'evt_1',
      eventType: 'payout.failed',
      providerReference: `${ACCOUNT}:pay_1`,
      accountReference: ACCOUNT,
      status: 'failed',
      currency: 'NGN',
      amountMinor: 150000n,
      feeMinor: 5000n,
      operationReference: 'p1',
    },
  });
  const inDebt = verify(
    payoutEvent('payout.failed', { failure_reason: 'ORGANIZATION_IN_DEBT' }),
  );
  assert.equal(inDebt.event.failureReason, 'in_debt');
});

test('a payout.paid whose own status disagrees is marked as contradicted', () => {
  const says = (data) => verify(payoutEvent('payout.paid', data)).event;
  assert.equal(says({}).contradicted, undefined);
  assert.equal(says({ status: 'completed' }).contradicted, undefined);
  assert.equal(says({ status: 'paid' }).contradicted, undefined);
  assert.equal(says({ status: 'failed' }).contradicted, true);
  assert.equal(says({ status: 'pending' }).contradicted, true);
});

test('a payout webhook names the connected account over the platform', () => {
  const result = verify(
    payoutEvent(
      'payout.paid',
      {},
      {
        account: ACCOUNT,
        organization_id: 'acct_platform',
      },
    ),
  );
  assert.equal(result.event.accountReference, ACCOUNT);
  assert.equal(result.event.providerReference, `${ACCOUNT}:pay_1`);
});

test('a payout webhook without its payout or account is malformed', () => {
  assert.deepEqual(
    verify(payoutEvent('payout.paid', { withdrawal_id: null })),
    {
      ok: false,
      reason: 'malformed',
    },
  );
  assert.deepEqual(
    verify(payoutEvent('payout.paid', {}, { organization_id: null })),
    { ok: false, reason: 'malformed' },
  );
  assert.deepEqual(
    verify(payoutEvent('payout.paid', {}, { organization_id: 'a:b' })),
    { ok: false, reason: 'malformed' },
  );
});

test('other payout events stay ignored', () => {
  const result = verify(payoutEvent('payout.created'));
  assert.equal(result.event.kind, 'ignored');
});
