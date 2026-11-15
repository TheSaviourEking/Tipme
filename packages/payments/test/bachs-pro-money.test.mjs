import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  PayoutRejectedError,
  PlatformRefusalError,
  ProRefundRefusedError,
  SavedCardRefusedError,
  UncertainProviderOutcomeError,
  createBachsProvider,
} from '../dist/index.js';

/*
 * Paid Pro, plan Tasks 8 to 10: paying from the TipMe balance (`destination: "self"`), refunding a
 * card month, and charging a saved naira card. Shapes follow the partner's guides (connect/transfers,
 * guides/refunds, guides/payments/charge-a-saved-card) and the sandbox evidence of 9 Nov 2026 (E3:
 * 201, status `paid`). Recorded responses only: nothing here reaches the network.
 */
const ACCOUNT = 'acct_ZH5luf3xSXZkDevh';
const PURCHASE = '0193f7a2-0000-7000-8000-00000000c0de';
const IDEMPOTENCY = `tipme-pro-${PURCHASE}`;
const SECRET = 'current-secret-0123456789';
const PLATFORM_ORG = 'acct_stWbI4933A4WVqkc';
const NOW = new Date('2026-11-11T12:00:00.000Z');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fake(answer) {
  const calls = [];
  const provider = createBachsProvider({
    apiKey: 'sk_sandbox_test',
    environment: 'sandbox',
    webhookSecrets: [SECRET],
    platformOrganizationId: PLATFORM_ORG,
    fetchImpl: async (url, init) => {
      const call = {
        method: init.method,
        path: `${url.pathname}${url.search}`,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(call);
      const next = typeof answer === 'function' ? answer(call) : answer;
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { provider, calls };
}

const collect = {
  accountRef: ACCOUNT,
  amountMinor: 250000n,
  currency: 'NGN',
  idempotencyKey: IDEMPOTENCY,
};
const transfer = (over = {}) => ({
  id: 'tr_aece90ad',
  status: 'paid',
  amount: '2500.00',
  currency: 'NGN',
  destination: PLATFORM_ORG,
  transfer_group: IDEMPOTENCY,
  ...over,
});

/* Task 8: pay from the balance */

test('collect sends X-Account-Id, destination self, amount "2500.00" and Idempotency-Key tipme-pro-<id>', async () => {
  const { provider, calls } = fake(jsonResponse(transfer(), 201));
  assert.deepEqual(await provider.collectToPlatform(collect), {
    transferRef: 'tr_aece90ad',
    status: 'paid',
  });
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/transfers');
  // The debited side is whoever authenticates: the person's own account.
  assert.equal(call.headers['X-Account-Id'], ACCOUNT);
  assert.equal(call.headers['Idempotency-Key'], IDEMPOTENCY);
  assert.equal(call.body.destination, 'self');
  assert.equal(call.body.amount, '2500.00');
  assert.equal(call.body.currency, 'NGN');
  assert.equal(call.body.transfer_group, IDEMPOTENCY);
});

test('a pending transfer is not yet paid', async () => {
  const { provider } = fake(jsonResponse(transfer({ status: 'pending' }), 201));
  assert.equal((await provider.collectToPlatform(collect)).status, 'pending');
});

test('ORGANIZATION_IN_DEBT and INSUFFICIENT_BALANCE are definite refusals about the person’s account', async () => {
  for (const code of ['ORGANIZATION_IN_DEBT', 'INSUFFICIENT_BALANCE']) {
    const { provider } = fake(jsonResponse({ error_code: code }, 400));
    await assert.rejects(
      provider.collectToPlatform(collect),
      (error) =>
        error instanceof PayoutRejectedError && error.providerCode === code,
    );
  }
});

test('a 403 (the account’s transfers capability is not active) is a definite refusal', async () => {
  const { provider } = fake(jsonResponse({ error_code: 'FORBIDDEN' }, 403));
  await assert.rejects(
    provider.collectToPlatform(collect),
    (error) =>
      error instanceof PlatformRefusalError ||
      error instanceof PayoutRejectedError,
  );
});

test('a network failure or a 5xx on a collect is uncertain, never a failure', async () => {
  for (const answer of [
    new TypeError('fetch failed'),
    jsonResponse({ error_code: 'INTERNAL' }, 502),
  ]) {
    const { provider } = fake(answer);
    await assert.rejects(
      provider.collectToPlatform(collect),
      UncertainProviderOutcomeError,
    );
  }
});

test('a transfer answering with another amount is uncertain', async () => {
  const { provider } = fake(jsonResponse(transfer({ amount: '25.00' }), 201));
  await assert.rejects(
    provider.collectToPlatform(collect),
    UncertainProviderOutcomeError,
  );
});

test('the read-back lists the account’s transfers and finds ours by its transfer_group', async () => {
  const { provider, calls } = fake(
    jsonResponse({
      items: [
        transfer({ id: 'tr_other', transfer_group: 'payout-fee.p1' }),
        transfer(),
      ],
    }),
  );
  assert.deepEqual(
    await provider.findPlatformCollection(ACCOUNT, IDEMPOTENCY),
    {
      transferRef: 'tr_aece90ad',
      status: 'paid',
      amountMinor: 250000n,
      currency: 'NGN',
    },
  );
  assert.equal(calls[0].method, 'GET');
  assert.equal(
    calls[0].path,
    `/v1/transfers?connected_account_id=${ACCOUNT}&limit=100`,
  );
  assert.equal(calls[0].headers['X-Account-Id'], undefined);
});

test('no transfer of ours in a short list is null; a full page without it proves nothing', async () => {
  const short = fake(jsonResponse({ items: [] }));
  assert.equal(
    await short.provider.findPlatformCollection(ACCOUNT, IDEMPOTENCY),
    null,
  );
  const full = fake(
    jsonResponse({
      items: Array.from({ length: 100 }, (_, i) =>
        transfer({ id: `tr_${i}`, transfer_group: `other.${i}` }),
      ),
    }),
  );
  await assert.rejects(
    full.provider.findPlatformCollection(ACCOUNT, IDEMPOTENCY),
    UncertainProviderOutcomeError,
  );
});

/* Task 9: refunds */

const refundInput = {
  chargeReference: 'ch_9f2b',
  amountMinor: 250000n,
  reference: 'tipme-pro-refund-r1',
  idempotencyKey: 'tipme-pro-refund-r1',
};

test('a refund names the charge, the amount, TipMe’s reference and key, on TipMe’s own account', async () => {
  const { provider, calls } = fake(
    jsonResponse(
      {
        refund_id: 'rf_1',
        charge_id: 'ch_9f2b',
        reference: 'tipme-pro-refund-r1',
        status: 'processing',
        requested_amount: '2500.00',
        refunded_amount: null,
        refund_fee_amount: '0',
      },
      201,
    ),
  );
  assert.deepEqual(await provider.refundPlatformCharge(refundInput), {
    refundReference: 'rf_1',
    status: 'processing',
  });
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/refunds');
  assert.equal(call.headers['X-Account-Id'], undefined);
  assert.equal(call.body.charge_id, 'ch_9f2b');
  assert.equal(call.body.amount, '2500.00');
  assert.equal(call.body.reference, 'tipme-pro-refund-r1');
  assert.equal(call.body.idempotency_key, 'tipme-pro-refund-r1');
});

test('a 400 refusal (not refundable, no balance) is definite; a 409 or a timeout is uncertain', async () => {
  const refused = fake(
    jsonResponse(
      {
        error_code: 'BAD_REQUEST',
        detail: 'Charge is not refundable in status refunded',
      },
      400,
    ),
  );
  await assert.rejects(
    refused.provider.refundPlatformCharge(refundInput),
    ProRefundRefusedError,
  );
  for (const answer of [
    jsonResponse({ error_code: 'CONFLICT' }, 409),
    jsonResponse({}, 503),
    new TypeError('fetch failed'),
  ]) {
    const { provider } = fake(answer);
    await assert.rejects(
      provider.refundPlatformCharge(refundInput),
      UncertainProviderOutcomeError,
    );
  }
});

/* Task 10: saved cards */

test('a customer is made on TipMe’s own account from an email and a name', async () => {
  const { provider, calls } = fake(
    jsonResponse({ customer_id: 'cust_1', email: 'ada@example.com' }, 201),
  );
  assert.deepEqual(
    await provider.createPlatformCustomer({
      email: 'ada@example.com',
      name: 'Ada',
      idempotencyKey: 'tipme-pro-customer-x',
    }),
    { customerReference: 'cust_1' },
  );
  assert.equal(calls[0].path, '/v1/customers');
  assert.equal(calls[0].headers['X-Account-Id'], undefined);
  assert.deepEqual(calls[0].body, { email: 'ada@example.com', name: 'Ada' });
});

test('a checkout with saveCard sends the customer and save_payment_method: true', async () => {
  const { provider, calls } = fake(
    jsonResponse(
      {
        checkout_id: 'cs_1',
        checkout_url: 'https://checkout.bachs.io/session/cs_1',
        status: 'open',
        expires_at: '2026-11-11T12:30:00Z',
      },
      201,
    ),
  );
  await provider.initializePlatformCheckout({
    purchaseId: PURCHASE,
    amountMinor: 250000n,
    currency: 'NGN',
    successUrl: 'https://usetipme.xyz/dashboard/settings',
    cancelUrl: 'https://usetipme.xyz/dashboard/settings',
    idempotencyKey: IDEMPOTENCY,
    saveCard: { customerReference: 'cust_1' },
  });
  assert.deepEqual(calls[0].body.customer, { customer_id: 'cust_1' });
  assert.equal(calls[0].body.save_payment_method, true);
});

const chargeInput = {
  customerReference: 'cust_1',
  paymentMethodReference: 'pm_1',
  amountMinor: 250000n,
  currency: 'NGN',
  reference: PURCHASE,
  idempotencyKey: IDEMPOTENCY,
};

test('an off-session charge names the customer, the card, ₦2,500 and the key; processing is not success', async () => {
  const { provider, calls } = fake(
    jsonResponse(
      {
        payment_id: 'ch_77',
        status: 'processing',
        amount: '2500.00',
        amount_paid: '0.00',
        currency: 'NGN',
      },
      201,
    ),
  );
  assert.deepEqual(await provider.chargeSavedCard(chargeInput), {
    providerReference: 'platform-charge:ch_77',
    status: 'pending',
  });
  const [call] = calls;
  assert.equal(call.path, '/v1/charges');
  assert.equal(call.headers['Idempotency-Key'], IDEMPOTENCY);
  assert.equal(call.headers['X-Account-Id'], undefined);
  assert.equal(call.body.customer, 'cust_1');
  assert.equal(call.body.payment_method, 'pm_1');
  assert.equal(call.body.amount, '2500.00');
  assert.equal(call.body.currency, 'NGN');
  assert.equal(call.body.reference, PURCHASE);
});

test('a refused card is a 201 with status failed; a saved-card error is definite; a timeout uncertain', async () => {
  const declined = fake(
    jsonResponse(
      { payment_id: 'ch_78', status: 'failed', amount_paid: '0.00' },
      201,
    ),
  );
  assert.equal(
    (await declined.provider.chargeSavedCard(chargeInput)).status,
    'failed',
  );
  for (const code of ['NO_SAVED_PAYMENT_METHOD', 'PAYMENT_METHOD_UNUSABLE']) {
    const { provider } = fake(jsonResponse({ error_code: code }, 400));
    await assert.rejects(
      provider.chargeSavedCard(chargeInput),
      SavedCardRefusedError,
    );
  }
  const lost = fake(new TypeError('fetch failed'));
  await assert.rejects(
    lost.provider.chargeSavedCard(chargeInput),
    UncertainProviderOutcomeError,
  );
});

test('a saved-card charge is read back from its payment, on TipMe’s own account', async () => {
  const { provider, calls } = fake(
    jsonResponse({
      payment_id: 'ch_77',
      status: 'succeeded',
      amount: '2500.00',
      currency: 'NGN',
      fees: { amount: '50.00', currency: 'NGN' },
      payment_method_type: 'CARD',
    }),
  );
  const read = await provider.verifyTransaction('platform-charge:ch_77');
  assert.equal(read.status, 'succeeded');
  assert.equal(read.amountMinor, 250000n);
  assert.equal(read.feeMinor, 5000n);
  assert.equal(read.chargeReference, 'ch_77');
  assert.equal(calls[0].path, '/v1/payments/ch_77');
  assert.equal(calls[0].headers['X-Account-Id'], undefined);
});

test('a paid own-account checkout read back names its charge, for a later refund', async () => {
  const answers = [
    jsonResponse({
      checkout_id: 'cs_1',
      status: 'completed',
      payment_status: 'paid',
      amount: '2500.00',
      currency: 'NGN',
      charge: { payment_id: 'ch_55' },
    }),
    jsonResponse({
      payment_id: 'ch_55',
      status: 'succeeded',
      amount: '2500.00',
      currency: 'NGN',
      fees: { amount: '50.00', currency: 'NGN' },
      payment_method_type: 'NGN_CARD',
    }),
  ];
  const { provider } = fake(() => answers.shift());
  const read = await provider.verifyTransaction('platform:cs_1');
  assert.equal(read.status, 'succeeded');
  assert.equal(read.chargeReference, 'ch_55');
});

/* Webhooks */

function signed(provider, body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const v1 = createHmac('sha256', SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  return provider.verifyWebhook(
    rawBody,
    { 'X-Bachs-Signature-V2': `t=${timestamp},v1=${v1}` },
    NOW,
  );
}
const noNetwork = () => new Error('webhooks never call the network');

test('payment_method.saved on TipMe’s own account names the customer and the card, ids only', () => {
  const { provider } = fake(noNetwork());
  const result = signed(provider, {
    id: 'evt_pm',
    type: 'payment_method.saved',
    organization_id: PLATFORM_ORG,
    data: {
      payment_method_id: 'pm_1',
      customer: { customer_id: 'cust_1', email: 'ada@example.com' },
      type: 'card',
      card_last4: '4242',
      currency: 'NGN',
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.event, {
    kind: 'saved_method',
    eventId: 'evt_pm',
    eventType: 'payment_method.saved',
    customerReference: 'cust_1',
    paymentMethodReference: 'pm_1',
  });
});

test('a saved card on a connected account is not TipMe’s: ignored', () => {
  const { provider } = fake(noNetwork());
  const result = signed(provider, {
    id: 'evt_pm2',
    type: 'payment_method.saved',
    account: ACCOUNT,
    data: { payment_method_id: 'pm_1', customer: { customer_id: 'cust_1' } },
  });
  assert.equal(result.event.kind, 'ignored');
});

test('an own-account collection with a charge and no checkout is the saved-card charge', () => {
  const { provider } = fake(noNetwork());
  for (const type of ['collection.succeeded', 'collection.failed']) {
    const result = signed(provider, {
      id: `evt_${type}`,
      type,
      organization_id: PLATFORM_ORG,
      data: {
        charge_id: 'ch_77',
        status: 'SUCCEEDED',
        amount: '2500.00',
        currency: 'NGN',
      },
    });
    assert.equal(result.event.scope, 'platform');
    assert.equal(result.event.providerReference, 'platform-charge:ch_77');
    assert.equal(result.event.chargeReference, 'ch_77');
  }
});

test('an own-account refund event names the charge it refunds', () => {
  const { provider } = fake(noNetwork());
  const result = signed(provider, {
    id: 'evt_rf',
    type: 'refund.paid',
    organization_id: PLATFORM_ORG,
    data: {
      refund_id: 'rf_1',
      charge_id: 'ch_55',
      reference: 'tipme-pro-refund-r1',
      status: 'success',
      refunded_amount: '2500.00',
      refund_fee_amount: '0',
    },
  });
  assert.equal(result.event.kind, 'reversal');
  assert.equal(result.event.scope, 'platform');
  assert.equal(result.event.chargeReference, 'ch_55');
  assert.equal(result.event.refundState, 'paid');
  assert.equal(result.event.refundedMinor, 250000n);
  assert.equal(result.event.operationReference, 'tipme-pro-refund-r1');
});
