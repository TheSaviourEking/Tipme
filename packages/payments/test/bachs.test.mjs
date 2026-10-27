import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  BachsApiError,
  BachsProtocolError,
  UncertainProviderOutcomeError,
  createBachsProvider,
  decimalToMinor,
  minorToDecimal,
} from '../dist/index.js';

const API_KEY = 'sk_sandbox_test';
const CURRENT_SECRET = 'current-secret-0123456789';
const PREVIOUS_SECRET = 'previous-secret-0123456789';
const NOW = new Date('2026-10-26T12:00:00.000Z');

function makeProvider(fetchImpl, config = {}) {
  return createBachsProvider({
    apiKey: API_KEY,
    webhookSecrets: [CURRENT_SECRET],
    fetchImpl,
    ...config,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sign(secret, timestamp, rawBody) {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
}

test('money conversion preserves exact minor units for currencies with 0, 2, and 3 digits', () => {
  assert.equal(minorToDecimal(123456n, 'NGN'), '1234.56');
  assert.equal(minorToDecimal(123456n, 'JPY'), '123456');
  assert.equal(minorToDecimal(123456n, 'KWD'), '123.456');
  assert.equal(decimalToMinor('1234.5', 'NGN'), 123450n);
  assert.equal(decimalToMinor('123456', 'JPY'), 123456n);
  assert.equal(decimalToMinor('123.456', 'KWD'), 123456n);
  assert.throws(() => decimalToMinor('1.001', 'NGN'), RangeError);
  assert.throws(() => decimalToMinor('1e3', 'NGN'), TypeError);
  assert.throws(() => minorToDecimal(-1n, 'NGN'), RangeError);
  assert.throws(() => minorToDecimal(1n, 'ZZZ'), TypeError);
});

test('checkout sends direct-charge account context, full TipMe share, and stable idempotency', async () => {
  let requestUrl;
  let requestInit;
  const provider = makeProvider(async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return jsonResponse(
      {
        checkout_id: 'chk_123abc',
        checkout_url: 'https://checkout.bachs.io/session/chk_123abc',
        status: 'open',
      },
      201,
    );
  });

  const result = await provider.initializePayment({
    attemptId: 'attempt-123',
    amountMinor: 100000n,
    currency: 'NGN',
    recipientAccountReference: 'acct_123abc',
    tipmeShareMinor: 10500n,
    successUrl: 'https://usetipme.xyz/checkout/return',
    cancelUrl: 'https://usetipme.xyz/checkout/cancel',
  });

  assert.equal(
    requestUrl.href,
    'https://sandbox-api.bachs.io/v1/checkout-sessions',
  );
  assert.equal(requestInit.method, 'POST');
  assert.equal(requestInit.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(requestInit.headers['X-Account-Id'], 'acct_123abc');
  assert.equal(
    requestInit.headers['Idempotency-Key'],
    'tipme-checkout-attempt-123',
  );
  assert.deepEqual(JSON.parse(requestInit.body), {
    pricing: { amount: '1000.00', currency: 'NGN' },
    reference: 'attempt-123',
    success_url: 'https://usetipme.xyz/checkout/return',
    cancel_url: 'https://usetipme.xyz/checkout/cancel',
    customer_creation: 'if_required',
    platform_fee: '105.00',
  });
  assert.deepEqual(result, {
    providerReference: 'acct_123abc:chk_123abc',
    checkoutUrl: 'https://checkout.bachs.io/session/chk_123abc',
  });
});

test('fee-free checkout omits platform_fee and invalid checkout input never reaches Bachs', async () => {
  let requestCount = 0;
  let requestBody;
  const providerWithBody = makeProvider(async (_url, init) => {
    requestCount += 1;
    requestBody = JSON.parse(init.body);
    return jsonResponse(
      {
        checkout_id: 'chk_123abc',
        checkout_url: 'https://checkout.bachs.io/session/chk_123abc',
        status: 'open',
      },
      201,
    );
  });

  await providerWithBody.initializePayment({
    attemptId: 'attempt-free',
    amountMinor: 100000n,
    currency: 'NGN',
    recipientAccountReference: 'acct_123abc',
    tipmeShareMinor: 0n,
    successUrl: 'http://localhost:3000/return',
    cancelUrl: 'http://localhost:3000/cancel',
  });
  assert.equal(Object.hasOwn(requestBody, 'platform_fee'), false);
  assert.equal(requestCount, 1);

  await assert.rejects(
    providerWithBody.initializePayment({
      attemptId: 'attempt-invalid',
      amountMinor: 100000n,
      currency: 'NGN',
      recipientAccountReference: 'acct_123abc',
      tipmeShareMinor: 100000n,
      successUrl: 'https://usetipme.xyz/return',
      cancelUrl: 'https://usetipme.xyz/cancel',
    }),
    RangeError,
  );
  assert.equal(requestCount, 1);
});

test('Bachs adapter rejects live keys and malformed webhook secrets', () => {
  assert.throws(
    () =>
      createBachsProvider({
        apiKey: 'sk_live_not-for-tests',
        webhookSecrets: [CURRENT_SECRET],
      }),
    /sandbox API keys only/,
  );
  // The API requires a secret in its config; a read-only adapter (the worker) has none.
  assert.throws(
    () => createBachsProvider({ apiKey: API_KEY, webhookSecrets: ['short'] }),
    /webhook secret/,
  );
});

test('uncertain checkout writes are not retried or mistaken for definite failures', async () => {
  let requestCount = 0;
  const provider = makeProvider(async () => {
    requestCount += 1;
    throw new TypeError('socket closed');
  });

  await assert.rejects(
    provider.initializePayment({
      attemptId: 'attempt-timeout',
      amountMinor: 100000n,
      currency: 'NGN',
      recipientAccountReference: 'acct_123abc',
      tipmeShareMinor: 10500n,
      successUrl: 'https://usetipme.xyz/return',
      cancelUrl: 'https://usetipme.xyz/cancel',
    }),
    UncertainProviderOutcomeError,
  );
  assert.equal(requestCount, 1);
  await assert.rejects(
    provider.findPayment('attempt-timeout'),
    UncertainProviderOutcomeError,
  );
  assert.equal(requestCount, 1);
});

test('server errors and malformed successful checkout responses remain uncertain', async (t) => {
  const cases = [
    ['server error', () => jsonResponse({ error: { code: 'TEMPORARY' } }, 500)],
    ['invalid success body', () => jsonResponse({ checkout_id: 'bad' }, 201)],
    [
      'unsafe success URL',
      () =>
        jsonResponse(
          {
            checkout_id: 'chk_123abc',
            checkout_url: 'https://attacker.example/session',
            status: 'open',
          },
          201,
        ),
    ],
  ];
  for (const [name, makeResponse] of cases) {
    await t.test(name, async () => {
      const provider = makeProvider(async () => makeResponse());
      await assert.rejects(
        provider.initializePayment({
          attemptId: `attempt-${name.replaceAll(' ', '-')}`,
          amountMinor: 100000n,
          currency: 'NGN',
          recipientAccountReference: 'acct_123abc',
          tipmeShareMinor: 10500n,
          successUrl: 'https://usetipme.xyz/return',
          cancelUrl: 'https://usetipme.xyz/cancel',
        }),
        UncertainProviderOutcomeError,
      );
    });
  }
});

test('lookup scopes checkout and payment reads to the connected account', async () => {
  const requests = [];
  const provider = makeProvider(async (url, init) => {
    requests.push({ url, init });
    if (url.pathname.includes('checkout-sessions')) {
      return jsonResponse({
        checkout_id: 'chk_123abc',
        status: 'completed',
        amount: '1000.00',
        currency: 'NGN',
        payment_status: 'paid',
        charge: { payment_id: 'ch_123abc' },
      });
    }
    return jsonResponse({
      payment_id: 'ch_123abc',
      status: 'succeeded',
      amount: '1000.00',
      amount_paid: '1000.00',
      currency: 'NGN',
      platform_fee: '105.00',
      fee_paid_by: 'platform',
      fees: { amount: '15.00', currency: 'NGN' },
    });
  });

  assert.deepEqual(
    await provider.verifyTransaction('acct_123abc:chk_123abc', {
      platformFeeMinor: 10500n,
    }),
    {
      status: 'succeeded',
      amountMinor: 100000n,
      currency: 'NGN',
      feeMinor: 1500n,
      feePaidBy: 'platform',
      platformFeeMinor: 10500n,
    },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers['X-Account-Id'], 'acct_123abc');
  assert.equal(requests[1].init.headers['X-Account-Id'], 'acct_123abc');
});

test('recipient-borne processing fee holds a completed payment pending', async () => {
  let nextResponse = 0;
  const responses = [
    jsonResponse({
      checkout_id: 'chk_123abc',
      status: 'completed',
      amount: '1000.00',
      currency: 'NGN',
      payment_status: 'paid',
      charge: { payment_id: 'ch_123abc' },
    }),
    jsonResponse({
      payment_id: 'ch_123abc',
      status: 'succeeded',
      amount: '1000.00',
      currency: 'NGN',
      fee_paid_by: 'merchant',
      fees: { amount: '15.00', currency: 'NGN' },
    }),
  ];
  const provider = makeProvider(async () => responses[nextResponse++]);

  assert.deepEqual(await provider.verifyTransaction('acct_123abc:chk_123abc'), {
    status: 'pending',
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 1500n,
    feePaidBy: 'connected_account',
    platformFeeMinor: 0n,
    collected: true,
  });
});

test('recipient fee attribution blocks success even when Bachs omits a fee amount', async () => {
  let responseIndex = 0;
  const responses = [
    jsonResponse({
      checkout_id: 'chk_123abc',
      status: 'completed',
      amount: '1000.00',
      currency: 'NGN',
      payment_status: 'paid',
      charge: { payment_id: 'ch_123abc' },
    }),
    jsonResponse({
      payment_id: 'ch_123abc',
      status: 'succeeded',
      amount: '1000.00',
      currency: 'NGN',
      fee_paid_by: 'merchant',
      fees: null,
    }),
  ];
  const provider = makeProvider(async () => responses[responseIndex++]);

  assert.deepEqual(await provider.verifyTransaction('acct_123abc:chk_123abc'), {
    status: 'pending',
    amountMinor: 100000n,
    currency: 'NGN',
    feeMinor: 0n,
    feePaidBy: 'connected_account',
    platformFeeMinor: 0n,
    collected: true,
  });
});

test('missing fee amount or fee attribution never marks a payment successful', async (t) => {
  for (const feePaidBy of [undefined, 'platform']) {
    await t.test(`fee payer ${feePaidBy ?? 'unknown'}`, async () => {
      let responseIndex = 0;
      const responses = [
        jsonResponse({
          checkout_id: 'chk_123abc',
          status: 'completed',
          amount: '1000.00',
          currency: 'NGN',
          payment_status: 'paid',
          charge: { payment_id: 'ch_123abc' },
        }),
        jsonResponse({
          payment_id: 'ch_123abc',
          status: 'succeeded',
          amount: '1000.00',
          currency: 'NGN',
          ...(feePaidBy ? { fee_paid_by: feePaidBy } : {}),
          fees: null,
        }),
      ];
      const provider = makeProvider(async () => responses[responseIndex++]);

      assert.deepEqual(
        await provider.verifyTransaction('acct_123abc:chk_123abc'),
        {
          status: 'pending',
          amountMinor: 100000n,
          currency: 'NGN',
          feeMinor: 0n,
          feePaidBy: feePaidBy ?? 'unknown',
          platformFeeMinor: 0n,
          collected: true,
        },
      );
    });
  }
});

test('open checkout remains pending and an expired checkout is a definite failure', async (t) => {
  await t.test('open', async () => {
    const provider = makeProvider(async () =>
      jsonResponse({
        checkout_id: 'chk_123abc',
        status: 'open',
        amount: '1000.00',
        currency: 'NGN',
        payment_status: 'unpaid',
      }),
    );
    assert.equal(
      (await provider.verifyTransaction('acct_123abc:chk_123abc')).status,
      'pending',
    );
  });

  await t.test('expired', async () => {
    const provider = makeProvider(async () =>
      jsonResponse({
        checkout_id: 'chk_123abc',
        status: 'expired',
        amount: '1000.00',
        currency: 'NGN',
      }),
    );
    assert.deepEqual(
      await provider.verifyTransaction('acct_123abc:chk_123abc'),
      {
        status: 'failed',
        amountMinor: 100000n,
        currency: 'NGN',
        feeMinor: 0n,
        feePaidBy: 'unknown',
      },
    );
  });
});

test('account creation requests NGN methods and trusts returned fee responsibility', async () => {
  let requestBody;
  let requestHeaders;
  const provider = makeProvider(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    requestHeaders = init.headers;
    return jsonResponse(
      {
        id: 'legacy-account-123',
        is_active: false,
        capabilities: {
          ngn_card_collection: { status: 'pending' },
          bank_transfer: { status: 'active' },
        },
        responsibilities: { fees: { collector: 'merchant' } },
        requirements: { currently_due: ['individual.address'] },
      },
      201,
    );
  });

  const account = await provider.createRecipientAccount({
    contactEmail: 'recipient@example.com',
    country: 'NG',
    displayName: 'Recipient',
    entityType: 'individual',
    idempotencyKey: 'tipme-account-recipient-123',
  });

  assert.deepEqual(requestBody.configuration, {
    merchant: {
      capabilities: {
        ngn_card_collection: { requested: true },
        bank_transfer: { requested: true },
      },
    },
  });
  assert.deepEqual(requestBody.responsibilities, {
    fees: { collector: 'platform' },
  });
  assert.equal(
    requestHeaders['Idempotency-Key'],
    'tipme-account-recipient-123',
  );
  assert.deepEqual(account, {
    accountReference: 'legacy-account-123',
    active: false,
    ngnCardCollectionStatus: 'pending',
    bankTransferStatus: 'active',
    feeCollector: 'connected_account',
    requirementsDue: ['individual.address'],
  });
});

test('checkout success accepts succeeded and exposes the authoritative platform fee', async () => {
  let responseIndex = 0;
  const responses = [
    jsonResponse({
      checkout_id: 'checkout-opaque',
      status: 'completed',
      amount: '1000.00',
      currency: 'NGN',
      payment_status: 'succeeded',
      charge: { payment_id: 'payment-opaque' },
    }),
    jsonResponse({
      payment_id: 'payment-opaque',
      status: 'succeeded',
      amount: '1000.00',
      currency: 'NGN',
      platform_fee: '105.00',
      fee_paid_by: 'platform',
      fees: { amount: '15.00', currency: 'NGN' },
    }),
  ];
  const provider = makeProvider(async () => responses[responseIndex++]);

  assert.deepEqual(
    await provider.verifyTransaction('legacy-account-123:checkout-opaque', {
      platformFeeMinor: 10500n,
    }),
    {
      status: 'succeeded',
      amountMinor: 100000n,
      currency: 'NGN',
      feeMinor: 1500n,
      feePaidBy: 'platform',
      platformFeeMinor: 10500n,
    },
  );
});

test('missing platform fee keeps an otherwise succeeded payment pending', async () => {
  let responseIndex = 0;
  const responses = [
    jsonResponse({
      checkout_id: 'chk_123abc',
      status: 'completed',
      amount: '1000.00',
      currency: 'NGN',
      payment_status: 'paid',
      charge: { payment_id: 'pay_123abc' },
    }),
    jsonResponse({
      payment_id: 'pay_123abc',
      status: 'succeeded',
      amount: '1000.00',
      currency: 'NGN',
      platform_fee: null,
      fee_paid_by: 'platform',
      fees: { amount: '15.00', currency: 'NGN' },
    }),
  ];
  const provider = makeProvider(async () => responses[responseIndex++]);

  assert.equal(
    (
      await provider.verifyTransaction('acct_123abc:chk_123abc', {
        platformFeeMinor: 10500n,
      })
    ).status,
    'pending',
  );
});

test('account and capability webhooks retain only normalized lifecycle evidence', () => {
  const provider = makeProvider(async () => {
    throw new Error('webhook verification must not call the network');
  });
  const rawBody = Buffer.from(
    JSON.stringify({
      id: 'evt_account_restricted',
      type: 'capability.updated',
      account: 'legacy-account-123',
      data: {
        capability: 'ngn_card_collection',
        status: 'restricted',
        customer: { email: 'private@example.com' },
      },
    }),
  );
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const result = provider.verifyWebhook(
    rawBody,
    {
      'X-Bachs-Signature-V2': `t=${timestamp},v1=${sign(
        CURRENT_SECRET,
        timestamp,
        rawBody,
      )}`,
    },
    NOW,
  );

  assert.deepEqual(result, {
    ok: true,
    event: {
      kind: 'account',
      eventId: 'evt_account_restricted',
      eventType: 'capability.updated',
      accountReference: 'legacy-account-123',
    },
  });
  assert.ok(!JSON.stringify(result).includes('private@example.com'));
});

test('onboarding links are returned only for Bachs HTTPS URLs', async () => {
  let requestBody;
  const provider = makeProvider(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse(
      {
        url: 'https://connect.bachs.io/onboarding/token',
      },
      201,
    );
  });

  assert.equal(
    await provider.createOnboardingLink({
      accountReference: 'acct_123abc',
      refreshUrl: 'https://usetipme.xyz/onboarding/refresh',
      returnUrl: 'https://usetipme.xyz/onboarding/return',
    }),
    'https://connect.bachs.io/onboarding/token',
  );
  assert.deepEqual(requestBody, {
    type: 'onboarding',
    refresh_url: 'https://usetipme.xyz/onboarding/refresh',
    return_url: 'https://usetipme.xyz/onboarding/return',
  });

  const invalidProvider = makeProvider(async () =>
    jsonResponse({ url: 'https://attacker.example/redirect' }, 201),
  );
  await assert.rejects(
    invalidProvider.createOnboardingLink({
      accountReference: 'acct_123abc',
      refreshUrl: 'https://usetipme.xyz/onboarding/refresh',
      returnUrl: 'https://usetipme.xyz/onboarding/return',
    }),
    BachsProtocolError,
  );
});

test('Bachs v2 webhook signatures support secret rotation and discard buyer PII', () => {
  const provider = makeProvider(
    async () => {
      throw new Error('webhook verification must not call the network');
    },
    { webhookSecrets: [CURRENT_SECRET, PREVIOUS_SECRET] },
  );
  const rawBody = Buffer.from(
    JSON.stringify({
      id: 'evt_123abc',
      type: 'collection.succeeded',
      organization_id: 'acct_123abc',
      data: {
        checkout_id: 'chk_123abc',
        reference: 'attempt-123',
        amount: '1000.00',
        currency: 'NGN',
        processing_fee: '15.00',
        processing_fee_currency: 'NGN',
        customer: { email: 'private@example.com' },
      },
    }),
  );
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const header = [
    `t=${timestamp}`,
    `v1=${sign(PREVIOUS_SECRET, timestamp, rawBody)}`,
    `v1=${sign(CURRENT_SECRET, timestamp, rawBody)}`,
  ].join(',');

  const result = provider.verifyWebhook(
    rawBody,
    { 'X-Bachs-Signature-V2': header },
    NOW,
  );

  assert.deepEqual(result, {
    ok: true,
    event: {
      kind: 'payment',
      eventId: 'evt_123abc',
      eventType: 'collection.succeeded',
      providerReference: 'acct_123abc:chk_123abc',
      operationReference: 'attempt-123',
      accountReference: 'acct_123abc',
      status: 'pending',
      amountMinor: 100000n,
      currency: 'NGN',
      feeMinor: 1500n,
      feePaidBy: 'unknown',
    },
  });
  assert.equal(Object.hasOwn(result.event, 'customer'), false);
});

test('invalid, stale, malformed, and underpaid webhook events fail closed', async (t) => {
  const provider = makeProvider(async () => {
    throw new Error('webhook verification must not call the network');
  });
  const rawBody = Buffer.from(
    JSON.stringify({
      id: 'evt_123abc',
      type: 'collection.underpaid',
      organization_id: 'acct_123abc',
      data: {
        checkout_id: 'chk_123abc',
        reference: 'attempt-123',
        amount_paid: '500.00',
        amount_expected: '1000.00',
        currency: 'NGN',
      },
    }),
  );
  const timestamp = String(Math.floor(NOW.getTime() / 1000));

  await t.test('underpaid maps to review, not paid or failed', () => {
    const result = provider.verifyWebhook(
      rawBody,
      {
        'X-Bachs-Signature-V2': `t=${timestamp},v1=${sign(
          CURRENT_SECRET,
          timestamp,
          rawBody,
        )}`,
      },
      NOW,
    );
    assert.equal(result.ok, true);
    assert.equal(result.event.status, 'review');
    assert.equal(result.event.amountMinor, 50000n);
    assert.equal(result.event.expectedAmountMinor, 100000n);
  });

  await t.test('bad signature', () => {
    assert.deepEqual(
      provider.verifyWebhook(
        rawBody,
        { 'X-Bachs-Signature-V2': `t=${timestamp},v1=${'0'.repeat(64)}` },
        NOW,
      ),
      { ok: false, reason: 'bad_signature' },
    );
  });

  await t.test('stale signature', () => {
    const staleTimestamp = String(Math.floor(NOW.getTime() / 1000) - 301);
    assert.deepEqual(
      provider.verifyWebhook(
        rawBody,
        {
          'X-Bachs-Signature-V2': `t=${staleTimestamp},v1=${sign(
            CURRENT_SECRET,
            staleTimestamp,
            rawBody,
          )}`,
        },
        NOW,
      ),
      { ok: false, reason: 'stale' },
    );
  });

  await t.test('malformed signature envelope', () => {
    assert.deepEqual(
      provider.verifyWebhook(
        rawBody,
        { 'X-Bachs-Signature-V2': `t=${timestamp}` },
        NOW,
      ),
      { ok: false, reason: 'malformed' },
    );
  });

  await t.test('malformed signed event', () => {
    const badBody = Buffer.from('{"id":"event-without-type"}');
    assert.deepEqual(
      provider.verifyWebhook(
        badBody,
        {
          'X-Bachs-Signature-V2': `t=${timestamp},v1=${sign(
            CURRENT_SECRET,
            timestamp,
            badBody,
          )}`,
        },
        NOW,
      ),
      { ok: false, reason: 'malformed' },
    );
  });

  await t.test(
    'unknown signed event is acknowledged without exposing its payload',
    () => {
      const unknownBody = Buffer.from(
        JSON.stringify({
          id: 'evt_unknown',
          type: 'customer.created',
          organization_id: 'org_platform',
          data: { email: 'private@example.com' },
        }),
      );
      const result = provider.verifyWebhook(
        unknownBody,
        {
          'X-Bachs-Signature-V2': `t=${timestamp},v1=${sign(
            CURRENT_SECRET,
            timestamp,
            unknownBody,
          )}`,
        },
        NOW,
      );
      assert.deepEqual(result, {
        ok: true,
        event: {
          kind: 'ignored',
          eventId: 'evt_unknown',
          eventType: 'customer.created',
        },
      });
    },
  );
});

test('legacy Bachs signature headers remain supported during migration', () => {
  const provider = makeProvider(async () => {
    throw new Error('webhook verification must not call the network');
  });
  const rawBody = Buffer.from(
    JSON.stringify({
      id: 'evt_legacy',
      type: 'collection.succeeded',
      organization_id: 'acct_123abc',
      data: {
        checkout_id: 'chk_123abc',
        amount: '1000.00',
        currency: 'NGN',
      },
    }),
  );
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  assert.deepEqual(
    provider.verifyWebhook(
      rawBody,
      {
        'X-Bachs-Timestamp': timestamp,
        'X-Bachs-Signature': sign(CURRENT_SECRET, timestamp, rawBody),
      },
      NOW,
    ),
    {
      ok: true,
      event: {
        kind: 'payment',
        eventId: 'evt_legacy',
        eventType: 'collection.succeeded',
        providerReference: 'acct_123abc:chk_123abc',
        operationReference: null,
        accountReference: 'acct_123abc',
        status: 'pending',
        amountMinor: 100000n,
        currency: 'NGN',
        feeMinor: undefined,
        feePaidBy: 'unknown',
      },
    },
  );
});

test('unsupported payout operations fail explicitly', async () => {
  const provider = makeProvider(async () => {
    throw new Error('unsupported calls must not reach Bachs');
  });
  assert.equal(provider.capabilities.payouts, false);
  await assert.rejects(
    provider.initiatePayout({
      payoutId: 'payout-123',
      idempotencyKey: 'payout-123',
      amountMinor: 100000n,
      currency: 'NGN',
    }),
    /does not support payouts/,
  );
  await assert.rejects(
    provider.fetchPayoutStatus('withdrawal_123'),
    /does not support payout status lookup/,
  );
});

test('definite client errors are not mislabeled as uncertain writes', async () => {
  const provider = makeProvider(async () =>
    jsonResponse({ error: { code: 'INVALID_REQUEST' } }, 400),
  );
  await assert.rejects(
    provider.initializePayment({
      attemptId: 'attempt-bad',
      amountMinor: 100000n,
      currency: 'NGN',
      recipientAccountReference: 'acct_123abc',
      tipmeShareMinor: 10500n,
      successUrl: 'https://usetipme.xyz/return',
      cancelUrl: 'https://usetipme.xyz/cancel',
    }),
    (error) =>
      error instanceof BachsApiError &&
      error.statusCode === 400 &&
      error.providerCode === 'INVALID_REQUEST',
  );
});

test('an account can take tips only with active NGN card collection and platform-paid fees', async () => {
  const { bachsAccountReadiness } = await import('../dist/index.js');
  const account = (overrides) => ({
    accountReference: 'acct_ready',
    active: true,
    ngnCardCollectionStatus: 'active',
    bankTransferStatus: 'active',
    feeCollector: 'platform',
    requirementsDue: [],
    ...overrides,
  });
  assert.deepEqual(bachsAccountReadiness(account({})), {
    status: 'ACTIVE',
    chargesEnabled: true,
  });
  // Not yet: still onboarding, nothing is wrong.
  for (const overrides of [
    { ngnCardCollectionStatus: 'pending' },
    { ngnCardCollectionStatus: null },
    { active: null },
    { feeCollector: 'unknown' },
  ])
    assert.deepEqual(bachsAccountReadiness(account(overrides)), {
      status: 'ONBOARDING',
      chargesEnabled: false,
    });
  // Blocked: the recipient would bear Bachs' fees, or Bachs restricted the account.
  for (const overrides of [
    { feeCollector: 'connected_account' },
    { ngnCardCollectionStatus: 'restricted' },
    { ngnCardCollectionStatus: 'inactive' },
    { active: false },
  ])
    assert.deepEqual(bachsAccountReadiness(account(overrides)), {
      status: 'RESTRICTED',
      chargesEnabled: false,
    });
});

test('a read-only Bachs adapter needs no webhook secret and refuses every webhook', async () => {
  const { createBachsProvider } = await import('../dist/index.js');
  const provider = createBachsProvider({
    apiKey: 'sk_sandbox_read_only',
    fetchImpl: async () => {
      throw new Error('no network in this test');
    },
  });
  const verification = provider.verifyWebhook(Buffer.from('{}'), {
    'x-bachs-signature-v2': `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`,
  });
  assert.equal(verification.ok, false);
});

test('a paid checkout awaiting settlement is pending but reported as collected', async () => {
  let responseIndex = 0;
  const responses = [
    jsonResponse({
      checkout_id: 'chk_123abc',
      status: 'completed',
      amount: '1000.00',
      currency: 'NGN',
      payment_status: 'paid',
      charge: { payment_id: 'ch_123abc' },
    }),
    // Settlement fields (fee_paid_by, fees) are not there yet.
    jsonResponse({
      payment_id: 'ch_123abc',
      status: 'succeeded',
      amount: '1000.00',
      currency: 'NGN',
      platform_fee: '105.00',
    }),
  ];
  const provider = makeProvider(async () => responses[responseIndex++]);
  const answer = await provider.verifyTransaction('acct_123abc:chk_123abc', {
    platformFeeMinor: 10500n,
  });
  assert.equal(answer.status, 'pending');
  assert.equal(answer.collected, true);
});

test('an open or expired checkout is never reported as collected', async () => {
  for (const status of ['open', 'expired']) {
    const provider = makeProvider(async () =>
      jsonResponse({
        checkout_id: 'chk_123abc',
        status,
        amount: '1000.00',
        currency: 'NGN',
        payment_status: null,
      }),
    );
    const answer = await provider.verifyTransaction('acct_123abc:chk_123abc');
    assert.equal(answer.collected, undefined, status);
  }
});
