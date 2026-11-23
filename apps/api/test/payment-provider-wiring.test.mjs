import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bachsProviderProvider,
  checkoutProviderProvider,
  mockAltProviderProvider,
  paymentProviderProvider,
  payoutProvidersProvider,
  withdrawalProviderProvider,
} from '../dist/checkout/payment-provider.provider.js';

// A production copy on bachs-live must never quietly check out through the pretend provider.
const mock = { name: 'mock', initializePayment: async () => ({}) };

test('bachs-live builds a live Bachs provider from the live key and live webhook secrets', async () => {
  const config = {
    PAYMENT_PROVIDER: 'bachs-live',
    BACHS_LIVE_API_KEY: 'sk_live_fake_for_tests',
    BACHS_LIVE_WEBHOOK_SECRET: 'l'.repeat(32),
    BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET: 'p'.repeat(32),
  };
  const bachs = bachsProviderProvider.useFactory(config);
  assert.equal(bachs.name, 'bachs-live');
  assert.equal(bachs.environment, 'live');
  const checkout = checkoutProviderProvider.useFactory(config, mock, bachs);
  assert.equal(checkout.name, 'bachs-live');
  assert.notEqual(checkout.name, mock.name);
  // Both live secrets authenticate callbacks; nothing else does.
  const body = Buffer.from('{"id":"evt_1"}');
  const t = Math.floor(Date.now() / 1000);
  const { createHmac } = await import('node:crypto');
  const signed = (secret) => ({
    'x-bachs-signature-v2': `t=${t},v1=${createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${t}.`), body]))
      .digest('hex')}`,
  });
  for (const secret of ['l'.repeat(32), 'p'.repeat(32)])
    assert.notEqual(
      bachs.verifyWebhook(body, signed(secret)).reason,
      'bad_signature',
    );
  assert.equal(
    bachs.verifyWebhook(body, signed('s'.repeat(32))).reason,
    'bad_signature',
  );
});

test('bachs-live never uses sandbox settings, and bachs-sandbox never uses live ones', () => {
  assert.throws(
    () =>
      bachsProviderProvider.useFactory({
        PAYMENT_PROVIDER: 'bachs-live',
        BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
        BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
      }),
    /Bachs live configuration is incomplete/,
  );
  assert.throws(
    () =>
      bachsProviderProvider.useFactory({
        PAYMENT_PROVIDER: 'bachs-live',
        BACHS_LIVE_API_KEY: 'sk_live_x',
      }),
    /Bachs live configuration is incomplete/,
  );
  assert.throws(
    () =>
      bachsProviderProvider.useFactory({
        PAYMENT_PROVIDER: 'bachs-sandbox',
        BACHS_LIVE_API_KEY: 'sk_live_x',
        BACHS_LIVE_WEBHOOK_SECRET: 'l'.repeat(32),
      }),
    /Bachs sandbox configuration is incomplete/,
  );
  // A checkout on bachs-live with no live adapter, or a sandbox one, fails closed.
  const live = { PAYMENT_PROVIDER: 'bachs-live' };
  assert.throws(
    () => checkoutProviderProvider.useFactory(live, mock, null),
    /PAYMENT_PROVIDER/,
  );
  const sandbox = bachsProviderProvider.useFactory({
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
  });
  assert.throws(
    () => checkoutProviderProvider.useFactory(live, mock, sandbox),
    /PAYMENT_PROVIDER/,
  );
});

test('mock and bachs-sandbox are unchanged', () => {
  const sandbox = {
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
  };
  const bachs = bachsProviderProvider.useFactory(sandbox);
  assert.equal(bachs.name, 'bachs-sandbox');
  assert.equal(bachs.environment, 'sandbox');
  assert.equal(
    checkoutProviderProvider.useFactory(sandbox, mock, bachs).name,
    'bachs-sandbox',
  );
  assert.equal(
    checkoutProviderProvider.useFactory(
      { PAYMENT_PROVIDER: 'mock' },
      mock,
      null,
    ).name,
    'mock',
  );
  assert.equal(
    bachsProviderProvider.useFactory({ PAYMENT_PROVIDER: 'mock' }),
    null,
  );
});

test('withdrawals use exactly the configured provider, and fail closed without it', () => {
  const sandboxConfig = {
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
  };
  const sandbox = bachsProviderProvider.useFactory(sandboxConfig);
  assert.equal(
    withdrawalProviderProvider.useFactory(sandboxConfig, mock, sandbox),
    sandbox,
  );
  // A mock copy that still answers old sandbox callbacks withdraws through mock.
  assert.equal(
    withdrawalProviderProvider.useFactory(
      { PAYMENT_PROVIDER: 'mock' },
      mock,
      sandbox,
    ),
    mock,
  );
  const live = { PAYMENT_PROVIDER: 'bachs-live' };
  for (const adapter of [null, sandbox])
    assert.throws(
      () => withdrawalProviderProvider.useFactory(live, mock, adapter),
      /PAYMENT_PROVIDER/,
    );
});

// Every provider in either role gets an adapter; checkout and the destination flows are unchanged.
const fakeRedis = {};
const wire = (config) => {
  const mockProvider = paymentProviderProvider.useFactory(config, fakeRedis);
  const bachs = bachsProviderProvider.useFactory(config);
  const alt = mockAltProviderProvider.useFactory(config, fakeRedis);
  const set = payoutProvidersProvider.useFactory(
    config,
    mockProvider,
    bachs,
    alt,
  );
  return { mockProvider, bachs, alt, set };
};

test('withdraw-only mock_alt beside active mock keeps active and withdraw-only separate, withdraw-only in list order', () => {
  const { mockProvider, alt, set } = wire({
    PAYMENT_PROVIDER: 'mock',
    PAYMENT_WITHDRAW_ONLY_PROVIDERS: ['mock_alt'],
    QUEUE_PREFIX: 'q',
  });
  assert.equal(alt.name, 'mock_alt');
  assert.equal(set.active, mockProvider);
  assert.deepEqual(
    set.withdrawOnly.map((p) => p.name),
    ['mock_alt'],
  );
  assert.equal(set.withdrawOnly[0], alt);
});

test('withdraw-only bachs-sandbox beside active mock builds the sandbox adapter and its webhooks', () => {
  const { bachs, set } = wire({
    PAYMENT_PROVIDER: 'mock',
    PAYMENT_WITHDRAW_ONLY_PROVIDERS: ['bachs-sandbox'],
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
  });
  assert.equal(bachs.name, 'bachs-sandbox');
  assert.equal(set.active.name, 'mock');
  assert.deepEqual(
    set.withdrawOnly.map((p) => p.name),
    ['bachs-sandbox'],
  );
  assert.equal(set.withdrawOnly[0], bachs);
  // The webhook endpoint verifies with this same adapter.
  assert.equal(bachs.verifyWebhook(Buffer.from('{}'), {}).ok, false);
});

test('no withdraw-only list gives withdrawOnly [] and no mock_alt adapter', () => {
  const { alt, set } = wire({ PAYMENT_PROVIDER: 'mock' });
  assert.deepEqual(set.withdrawOnly, []);
  assert.equal(alt, null);
});

test('checkout still uses only the active provider', () => {
  const config = {
    PAYMENT_PROVIDER: 'mock',
    PAYMENT_WITHDRAW_ONLY_PROVIDERS: ['mock_alt', 'bachs-sandbox'],
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
  };
  const { mockProvider, bachs } = wire(config);
  const checkout = checkoutProviderProvider.useFactory(
    config,
    mockProvider,
    bachs,
  );
  assert.equal(checkout.name, 'mock');
  assert.equal(checkout.getCheckoutUrl, undefined);
  assert.equal(
    withdrawalProviderProvider.useFactory(config, mockProvider, bachs),
    mockProvider,
  );
});

test('QUEUE_PREFIX reaches the mock_alt keys, and only mock_alt carries :mock_alt', async () => {
  const keys = [];
  const recording = {
    set: async (key) => void keys.push(key),
    del: async (key) => void keys.push(key),
  };
  const config = {
    PAYMENT_PROVIDER: 'mock',
    PAYMENT_WITHDRAW_ONLY_PROVIDERS: ['mock_alt'],
    QUEUE_PREFIX: 'pfx',
  };
  const active = paymentProviderProvider.useFactory(config, recording);
  const alt = mockAltProviderProvider.useFactory(config, recording);
  await active.markPayoutBalance('acct_1', 5n);
  await alt.markPayoutBalance('acct_1', 5n);
  assert.equal(keys.length, 2);
  assert.ok(keys[0].includes('pfx'));
  assert.ok(!keys[0].includes(':mock_alt'));
  assert.ok(keys[1].includes('pfx:mock_alt'));
});
