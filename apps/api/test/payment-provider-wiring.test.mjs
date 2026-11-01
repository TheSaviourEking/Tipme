import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bachsProviderProvider,
  checkoutProviderProvider,
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
