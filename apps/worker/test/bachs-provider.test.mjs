import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerBachsProvider } from '../dist/job-worker.js';

// The worker only asks Bachs for statuses: it gets the configured environment's key and nothing
// that would let it accept a webhook.

test('bachs-live gives the worker a read-only live provider from the live key', () => {
  const bachs = workerBachsProvider({
    PAYMENT_PROVIDER: 'bachs-live',
    BACHS_LIVE_API_KEY: 'sk_live_fake_for_tests',
  });
  assert.equal(bachs.name, 'bachs-live');
  assert.equal(bachs.environment, 'live');
  assert.equal(
    bachs.verifyWebhook(Buffer.from('{}'), {}).ok,
    false,
    'a read-only adapter refuses every webhook',
  );
});

test('bachs-sandbox gives a sandbox provider; neither uses the other environment', () => {
  const bachs = workerBachsProvider({
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
  });
  assert.equal(bachs.name, 'bachs-sandbox');
  assert.equal(bachs.environment, 'sandbox');
  assert.throws(
    () =>
      workerBachsProvider({
        PAYMENT_PROVIDER: 'bachs-live',
        BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
      }),
    /BACHS_LIVE_API_KEY/,
  );
  assert.throws(
    () =>
      workerBachsProvider({
        PAYMENT_PROVIDER: 'bachs-sandbox',
        BACHS_LIVE_API_KEY: 'sk_live_x',
      }),
    /BACHS_SANDBOX_API_KEY/,
  );
});

test('mock keeps a sandbox reader only when a sandbox key is set', () => {
  assert.equal(workerBachsProvider({ PAYMENT_PROVIDER: 'mock' }), null);
  assert.equal(
    workerBachsProvider({
      PAYMENT_PROVIDER: 'mock',
      BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
    }).environment,
    'sandbox',
  );
});
