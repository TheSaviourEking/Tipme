import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PayoutRejectedError,
  PlatformRefusalError,
  UncertainProviderOutcomeError,
  createBachsProvider,
} from '../dist/index.js';

/*
 * Business release 2 on option B: a business's share moves staff -> TipMe -> business in two
 * transfers, and back the same way on a refund. Every response here is recorded from the sandbox
 * evidence of 11 Nov 2026 (S1 receive-only company account; S3 the two legs, 201 `paid`, a replay
 * with the same key returning the same transfer; S4 account to account refused; S5 recovery after
 * a withdrawal refused INSUFFICIENT_BALANCE). Nothing here reaches the network.
 */
const STAFF = 'acct_ZH5luf3xSXZkDevh';
const BUSINESS = 'acct_kLWx4FJ5z2dExsvz';
const PLATFORM_ORG = 'acct_stWbI4933A4WVqkc';
const OUT_KEY = 'tipme-share-out-0193f7a2-0000-7000-8000-00000000beef';
const IN_KEY = 'tipme-share-in-0193f7a2-0000-7000-8000-00000000beef';

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
    webhookSecrets: ['current-secret-0123456789'],
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

// S3 leg 1 (tr_dee082c3…) and leg 2 (tr_2b79c721…), as the sandbox answered.
const leg1 = {
  id: 'tr_dee082c37a66448e9b2fe260',
  status: 'paid',
  kind: 'manual',
  amount: '1800.00',
  currency: 'NGN',
  destination: PLATFORM_ORG,
  transfer_group: OUT_KEY,
};
const leg2 = {
  id: 'tr_2b79c72172a24c7da91d43f7',
  status: 'paid',
  kind: 'manual',
  amount: '1800.00',
  currency: 'NGN',
  destination: BUSINESS,
  transfer_group: IN_KEY,
};

test('leg 1: the staff account sends the share to TipMe (X-Account-Id, destination self, its own key)', async () => {
  const { provider, calls } = fake(jsonResponse(leg1, 201));
  assert.deepEqual(
    await provider.collectToPlatform({
      accountRef: STAFF,
      amountMinor: 180000n,
      currency: 'NGN',
      idempotencyKey: OUT_KEY,
      description: 'TipMe business share',
    }),
    { transferRef: leg1.id, status: 'paid' },
  );
  const [call] = calls;
  assert.equal(call.path, '/v1/transfers');
  assert.equal(call.headers['X-Account-Id'], STAFF);
  assert.equal(call.headers['Idempotency-Key'], OUT_KEY);
  assert.equal(call.body.destination, 'self');
  assert.equal(call.body.amount, '1800.00');
  assert.equal(call.body.description, 'TipMe business share');
  assert.equal(call.body.transfer_group, OUT_KEY);
});

test('leg 2: TipMe sends the share to the business, as the platform (no X-Account-Id)', async () => {
  const { provider, calls } = fake(jsonResponse(leg2, 201));
  assert.deepEqual(
    await provider.transferToAccount({
      accountRef: BUSINESS,
      amountMinor: 180000n,
      currency: 'NGN',
      idempotencyKey: IN_KEY,
      description: 'TipMe business share',
    }),
    { transferRef: leg2.id, status: 'paid' },
  );
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/transfers');
  // The debited side is whoever authenticates: TipMe itself, so the platform is on one side.
  assert.equal(call.headers['X-Account-Id'], undefined);
  assert.equal(call.headers['Idempotency-Key'], IN_KEY);
  assert.equal(call.body.destination, BUSINESS);
  assert.notEqual(call.body.destination, 'self');
  assert.equal(call.body.amount, '1800.00');
  assert.equal(call.body.transfer_group, IN_KEY);
});

test('a replay with the same key answers the same transfer, and is still one transfer', async () => {
  const { provider, calls } = fake(() => jsonResponse(leg2, 201));
  const input = {
    accountRef: BUSINESS,
    amountMinor: 180000n,
    currency: 'NGN',
    idempotencyKey: IN_KEY,
    description: 'TipMe business share',
  };
  const first = await provider.transferToAccount(input);
  const again = await provider.transferToAccount(input);
  assert.equal(first.transferRef, again.transferRef);
  assert.deepEqual(
    calls.map((call) => call.headers['Idempotency-Key']),
    [IN_KEY, IN_KEY],
  );
});

test('leg 2 refused for TipMe’s own balance is definite; a 5xx or no answer is uncertain', async () => {
  const empty = fake(jsonResponse({ error_code: 'INSUFFICIENT_BALANCE' }, 400));
  await assert.rejects(
    empty.provider.transferToAccount({
      accountRef: BUSINESS,
      amountMinor: 180000n,
      currency: 'NGN',
      idempotencyKey: IN_KEY,
      description: 'TipMe business share',
    }),
    PlatformRefusalError,
  );
  for (const answer of [
    new TypeError('fetch failed'),
    jsonResponse({ error_code: 'INTERNAL' }, 502),
  ]) {
    const { provider } = fake(answer);
    await assert.rejects(
      provider.transferToAccount({
        accountRef: BUSINESS,
        amountMinor: 180000n,
        currency: 'NGN',
        idempotencyKey: IN_KEY,
        description: 'TipMe business share',
      }),
      UncertainProviderOutcomeError,
    );
  }
});

test('a transfer answering another destination or amount is uncertain, never taken as done', async () => {
  for (const over of [{ destination: STAFF }, { amount: '18.00' }]) {
    const { provider } = fake(jsonResponse({ ...leg2, ...over }, 201));
    await assert.rejects(
      provider.transferToAccount({
        accountRef: BUSINESS,
        amountMinor: 180000n,
        currency: 'NGN',
        idempotencyKey: IN_KEY,
        description: 'TipMe business share',
      }),
      UncertainProviderOutcomeError,
    );
  }
});

test('S5: pulling a share back from a business that withdrew it is a definite INSUFFICIENT_BALANCE', async () => {
  const { provider } = fake(
    jsonResponse(
      {
        error_code: 'INSUFFICIENT_BALANCE',
        message: 'Insufficient available balance for this transfer',
      },
      400,
    ),
  );
  await assert.rejects(
    provider.collectToPlatform({
      accountRef: BUSINESS,
      amountMinor: 180000n,
      currency: 'NGN',
      idempotencyKey: OUT_KEY,
      description: 'TipMe business share',
    }),
    (error) =>
      error instanceof PayoutRejectedError &&
      error.providerCode === 'INSUFFICIENT_BALANCE',
  );
});

test('the read-back finds leg 2 among the business account’s transfers by its group', async () => {
  const { provider, calls } = fake(jsonResponse({ items: [leg1, leg2] }));
  assert.deepEqual(await provider.findPlatformCollection(BUSINESS, IN_KEY), {
    transferRef: leg2.id,
    status: 'paid',
    amountMinor: 180000n,
    currency: 'NGN',
  });
  assert.equal(
    calls[0].path,
    `/v1/transfers?connected_account_id=${BUSINESS}&limit=100`,
  );
});

test('S1: a business account only receives: recipient payouts and transfers, no merchant persona', async () => {
  const { provider, calls } = fake(
    jsonResponse(
      {
        id: BUSINESS,
        country: 'NG',
        is_active: false,
        capabilities: {
          payouts: { status: 'active' },
          transfers: { status: 'active' },
          conversions: { status: 'active' },
        },
        responsibilities: { fees: { collector: 'platform' } },
        requirements: { currently_due: ['persons.name', 'payout_destination'] },
      },
      201,
    ),
  );
  const account = await provider.createReceiveOnlyAccount({
    contactEmail: 'owner@example.com',
    country: 'NG',
    displayName: 'The Yellow Chilli',
    idempotencyKey: 'tipme-biz-acct-0193f7a2-0000-7000-8000-00000000beef',
  });
  assert.equal(account.accountReference, BUSINESS);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/accounts');
  assert.equal(call.body.entity_type, 'company');
  assert.equal(call.body.configuration.merchant, undefined);
  assert.deepEqual(call.body.configuration.recipient.capabilities, {
    payouts: { requested: true },
    transfers: { requested: true },
  });
});
