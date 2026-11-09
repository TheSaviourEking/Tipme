import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BachsApiError,
  PlatformCheckoutUnavailableError,
  UncertainProviderOutcomeError,
  createBachsProvider,
} from '../dist/index.js';

// Paid Pro, plan Task 5 (ADR-0015): a checkout on TipMe's OWN partner account. No connected account,
// no platform fee. Shapes follow the sandbox evidence of 9 Nov 2026 (201, status open, a checkout URL,
// about 30 minutes to pay). Recorded responses only: nothing here reaches the network.
const PURCHASE = '0193f7a2-0000-7000-8000-00000000c0de';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recording(responses) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return typeof next === 'function' ? next() : next;
  };
  const provider = createBachsProvider({
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: ['current-secret-0123456789'],
    fetchImpl,
  });
  return { provider, requests };
}

const OPEN = {
  checkout_id: 'cs_pro_123',
  checkout_url: 'https://checkout.bachs.io/session/cs_pro_123',
  status: 'open',
  expires_at: '2026-11-09T21:45:00Z',
};

const input = {
  purchaseId: PURCHASE,
  amountMinor: 250000n,
  currency: 'NGN',
  successUrl: 'https://usetipme.xyz/dashboard/pro/return',
  cancelUrl: 'https://usetipme.xyz/dashboard/settings#plan',
  idempotencyKey: `tipme-pro-${PURCHASE}`,
};

test('the request has no X-Account-Id and no platform_fee: ₦2,500 on TipMe’s own account, card or bank transfer', async () => {
  const { provider, requests } = recording([jsonResponse(OPEN, 201)]);
  assert.equal(provider.capabilities.platformCheckout, true);
  const result = await provider.initializePlatformCheckout(input);
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url, 'https://sandbox-api.bachs.io/v1/checkout-sessions');
  assert.equal(init.method, 'POST');
  assert.equal(Object.hasOwn(init.headers, 'X-Account-Id'), false);
  assert.equal(init.headers['Idempotency-Key'], `tipme-pro-${PURCHASE}`);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.pricing, { amount: '2500.00', currency: 'NGN' });
  assert.deepEqual(body.payment_method_types, [
    'NGN_CARD',
    'NGN_BANK_TRANSFER',
  ]);
  assert.equal(body.customer_bears_fee, false);
  assert.equal(body.expires_in_minutes, 30);
  assert.equal(body.reference, PURCHASE);
  assert.equal(Object.hasOwn(body, 'platform_fee'), false);
  assert.deepEqual(result, {
    providerReference: 'platform:cs_pro_123',
    checkoutUrl: 'https://checkout.bachs.io/session/cs_pro_123',
    expiresAt: new Date('2026-11-09T21:45:00Z'),
  });
});

test('every request names TipMe as its User-Agent (the sandbox edge refuses requests without one)', async () => {
  const { provider, requests } = recording([jsonResponse(OPEN, 201)]);
  await provider.initializePlatformCheckout(input);
  assert.match(requests[0].init.headers['User-Agent'], /^TipMe\//);
});

test('a checkout made in another state raises UncertainProviderOutcomeError', async () => {
  const { provider } = recording([
    jsonResponse({ ...OPEN, status: 'complete' }, 201),
  ]);
  await assert.rejects(
    provider.initializePlatformCheckout(input),
    UncertainProviderOutcomeError,
  );
});

test('ACCOUNT_NOT_ACTIVATED is a definite refusal: TipMe’s own account can’t take payments yet', async () => {
  const { provider } = recording([
    jsonResponse(
      {
        detail: 'Account is not activated for live payments',
        error_code: 'ACCOUNT_NOT_ACTIVATED',
      },
      403,
    ),
  ]);
  await assert.rejects(
    provider.initializePlatformCheckout(input),
    (error) =>
      error instanceof PlatformCheckoutUnavailableError &&
      error.providerCode === 'ACCOUNT_NOT_ACTIVATED',
  );
});

test('another 4xx is definite too; a 5xx or no answer is uncertain', async () => {
  const refused = recording([
    jsonResponse({ error_code: 'VALIDATION_ERROR' }, 422),
  ]);
  await assert.rejects(
    refused.provider.initializePlatformCheckout(input),
    BachsApiError,
  );
  const unknown = recording([jsonResponse({}, 502)]);
  await assert.rejects(
    unknown.provider.initializePlatformCheckout(input),
    UncertainProviderOutcomeError,
  );
});

test('the price is checked before anything is sent', async () => {
  const { provider, requests } = recording([]);
  await assert.rejects(
    provider.initializePlatformCheckout({ ...input, amountMinor: 0n }),
  );
  await assert.rejects(
    provider.initializePlatformCheckout({ ...input, currency: 'USD' }),
  );
  await assert.rejects(
    provider.initializePlatformCheckout({
      ...input,
      successUrl: 'http://evil.example',
    }),
  );
  assert.equal(requests.length, 0);
});

const COMPLETED = {
  checkout_id: 'cs_pro_123',
  status: 'completed',
  amount: '2500.00',
  currency: 'NGN',
  payment_status: 'paid',
  charge: { payment_id: 'pay_pro_123' },
};
const PAID = {
  payment_id: 'pay_pro_123',
  status: 'succeeded',
  amount: '2500.00',
  currency: 'NGN',
  fees: { amount: '50.00', currency: 'NGN' },
  payment_method_type: 'NGN_CARD',
};

test('the status of platform:<id> is read with no account header, and its fee is the read-back’s', async () => {
  const { provider, requests } = recording([
    jsonResponse(COMPLETED),
    jsonResponse(PAID),
  ]);
  const verified = await provider.verifyTransaction('platform:cs_pro_123');
  assert.deepEqual(verified, {
    status: 'succeeded',
    amountMinor: 250000n,
    currency: 'NGN',
    feeMinor: 5000n,
    feePaidBy: 'platform',
    method: 'NGN_CARD',
  });
  assert.equal(
    requests[0].url,
    'https://sandbox-api.bachs.io/v1/checkout-sessions/cs_pro_123',
  );
  assert.equal(
    requests[1].url,
    'https://sandbox-api.bachs.io/v1/payments/pay_pro_123',
  );
  for (const { init } of requests)
    assert.equal(Object.hasOwn(init.headers, 'X-Account-Id'), false);
});

test('a bank transfer is read back as NGN_BANK_TRANSFER with its own fee', async () => {
  const { provider } = recording([
    jsonResponse(COMPLETED),
    jsonResponse({
      ...PAID,
      fees: { amount: '37.50', currency: 'NGN' },
      payment_method_type: 'NGN_BANK_TRANSFER',
    }),
  ]);
  const verified = await provider.verifyTransaction('platform:cs_pro_123');
  assert.equal(verified.method, 'NGN_BANK_TRANSFER');
  assert.equal(verified.feeMinor, 3750n);
});

test('an open or expired platform checkout is pending or failed; a paid one with no fee yet is collected, pending', async () => {
  const open = recording([
    jsonResponse({ ...COMPLETED, status: 'open', payment_status: null }),
  ]);
  assert.equal(
    (await open.provider.verifyTransaction('platform:cs_pro_123')).status,
    'pending',
  );
  const expired = recording([
    jsonResponse({ ...COMPLETED, status: 'expired', payment_status: null }),
  ]);
  assert.equal(
    (await expired.provider.verifyTransaction('platform:cs_pro_123')).status,
    'failed',
  );
  const noFee = recording([
    jsonResponse(COMPLETED),
    jsonResponse({ ...PAID, fees: null }),
  ]);
  const read = await noFee.provider.verifyTransaction('platform:cs_pro_123');
  assert.equal(read.status, 'pending');
  assert.equal(read.collected, true);
});

test('a short or over payment is reported as it was paid, for TipMe to hold', async () => {
  const { provider } = recording([
    jsonResponse(COMPLETED),
    jsonResponse({ ...PAID, amount_paid: '2000.00' }),
  ]);
  const verified = await provider.verifyTransaction('platform:cs_pro_123');
  assert.equal(verified.status, 'succeeded');
  assert.equal(verified.amountMinor, 200000n);
});
