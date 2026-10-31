import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bachsProviderProvider,
  checkoutProviderProvider,
} from '../dist/checkout/payment-provider.provider.js';

// A production copy on bachs-live must never quietly check out through the pretend provider.
const mock = { name: 'mock', initializePayment: async () => ({}) };

test('building the API providers with bachs-live throws and names PAYMENT_PROVIDER', () => {
  const config = {
    PAYMENT_PROVIDER: 'bachs-live',
    BACHS_LIVE_API_KEY: 'sk_live_x',
  };
  assert.throws(
    () => bachsProviderProvider.useFactory(config),
    /PAYMENT_PROVIDER/,
  );
  assert.throws(
    () => checkoutProviderProvider.useFactory(config, mock, null),
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
  assert.equal(
    checkoutProviderProvider.useFactory(sandbox, mock, bachs).name,
    bachs.name,
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
