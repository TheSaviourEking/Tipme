import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BachsRequestNotSentError,
  TipRefundRefusedError,
  UncertainProviderOutcomeError,
  createBachsProvider,
} from '../dist/index.js';

/*
 * Staff "Refund tip" (owner, 14 Nov 2026), on the sandbox evidence of 14 Nov: POST /v1/refunds with
 * X-Account-Id: <recipient account>, amount "9300.00", a reference and an idempotency key debits only
 * that account, by exactly the amount; the platform fee isn't refunded; the same key returns the same
 * refund; without the header the call is 404. Recorded responses only: nothing reaches the network.
 */
const ACCOUNT = 'acct_ZH5luf3xSXZkDevh';
const CHECKOUT = 'chk_AerEhGiKhfIol2z7';
const CHARGE = 'ch_2a78c44246f5466786ad6da3549a5d56';
const REFUND_ID = '0193f7a2-0000-7000-8000-00000000f00d';
const KEY = `tipme-tip-refund-${REFUND_ID}`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const checkout = {
  checkout_id: CHECKOUT,
  status: 'completed',
  amount: '10000.00',
  currency: 'NGN',
  payment_status: 'paid',
  charge: { payment_id: CHARGE },
};
const payment = (over = {}) => ({
  payment_id: CHARGE,
  status: 'succeeded',
  amount: '10000.00',
  currency: 'NGN',
  platform_fee: '700.00',
  fee_paid_by: 'platform',
  payment_method_type: 'NGN_CARD',
  is_refundable: true,
  ...over,
});

function fake({ paymentOver = {}, refund } = {}) {
  const calls = [];
  const provider = createBachsProvider({
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: ['current-secret-0123456789'],
    platformOrganizationId: 'acct_stWbI4933A4WVqkc',
    fetchImpl: async (url, init) => {
      const call = {
        method: init.method,
        path: `${url.pathname}${url.search}`,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(call);
      if (call.path.startsWith('/v1/checkout-sessions/'))
        return jsonResponse(checkout);
      if (call.path.startsWith('/v1/payments/'))
        return jsonResponse(payment(paymentOver));
      if (call.path === '/v1/refunds') {
        if (refund instanceof Error) throw refund;
        return (
          refund ??
          jsonResponse(
            { refund_id: 'rfnd_FFCuDvKtWzfdOV5S', status: 'processing' },
            201,
          )
        );
      }
      throw new Error(`unexpected call ${call.path}`);
    },
  });
  return { provider, calls };
}

const input = {
  providerReference: `${ACCOUNT}:${CHECKOUT}`,
  amountMinor: 930000n,
  reference: KEY,
  idempotencyKey: KEY,
};

test('reading a tip’s charge: its checkout, then its payment, both as the recipient’s account', async () => {
  const { provider, calls } = fake();
  assert.deepEqual(await provider.readAccountCharge(`${ACCOUNT}:${CHECKOUT}`), {
    chargeReference: CHARGE,
    method: 'card',
    refundable: true,
  });
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.headers['X-Account-Id']]),
    [
      ['GET', `/v1/checkout-sessions/${CHECKOUT}`, ACCOUNT],
      ['GET', `/v1/payments/${CHARGE}`, ACCOUNT],
    ],
  );
});

test('the refund: POST /v1/refunds as the account, the tip minus TipMe’s fee, with the key', async () => {
  const { provider, calls } = fake();
  assert.deepEqual(await provider.refundAccountCharge(input), {
    refundReference: 'rfnd_FFCuDvKtWzfdOV5S',
    status: 'processing',
  });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/v1/refunds');
  assert.equal(post.headers['X-Account-Id'], ACCOUNT);
  assert.equal(post.headers['Idempotency-Key'], KEY);
  assert.deepEqual(post.body, {
    charge_id: CHARGE,
    amount: '9300.00',
    reference: KEY,
    idempotency_key: KEY,
  });
});

test('a bank-transfer tip can’t be refunded by the partner: refused before any refund call', async () => {
  const { provider, calls } = fake({
    paymentOver: {
      payment_method_type: 'NGN_BANK_TRANSFER',
      is_refundable: false,
    },
  });
  assert.deepEqual(await provider.readAccountCharge(`${ACCOUNT}:${CHECKOUT}`), {
    chargeReference: CHARGE,
    method: 'bank_transfer',
    refundable: false,
  });
  await assert.rejects(provider.refundAccountCharge(input), (error) => {
    assert.ok(error instanceof TipRefundRefusedError);
    assert.equal(error.reason, 'bank_transfer');
    return true;
  });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('a payment the partner says isn’t refundable (already refunded): refused, nothing sent', async () => {
  const { provider, calls } = fake({ paymentOver: { is_refundable: false } });
  await assert.rejects(provider.refundAccountCharge(input), (error) => {
    assert.equal(error.reason, 'not_refundable');
    return true;
  });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('a 400 is a definite refusal (e.g. no balance); a 5xx or a lost answer is uncertain', async () => {
  const refused = fake({
    refund: jsonResponse(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'Insufficient balance to refund',
        },
      },
      400,
    ),
  });
  await assert.rejects(refused.provider.refundAccountCharge(input), (error) => {
    assert.ok(error instanceof TipRefundRefusedError);
    assert.equal(error.reason, 'refused');
    return true;
  });
  const down = fake({
    refund: jsonResponse({ error: { code: 'INTERNAL' } }, 502),
  });
  await assert.rejects(
    down.provider.refundAccountCharge(input),
    UncertainProviderOutcomeError,
  );
});

test('a reference with no recipient account is never sent (no refund from TipMe’s own balance)', async () => {
  const { provider, calls } = fake();
  await assert.rejects(
    provider.refundAccountCharge({
      ...input,
      providerReference: `platform:${CHECKOUT}`,
    }),
    BachsRequestNotSentError,
  );
  await assert.rejects(
    provider.refundAccountCharge({ ...input, amountMinor: 0n }),
    BachsRequestNotSentError,
  );
  assert.equal(calls.length, 0);
});
