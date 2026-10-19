import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppModule } from '../dist/app.module.js';
import { MockCheckoutModule } from '../dist/checkout/mock-checkout.module.js';
import { testConfig } from './helpers.mjs';

const logger = { info() {}, warn() {}, error() {} };

test('the pretend checkout exists only with the mock provider', () => {
  const config = testConfig();
  assert.ok(
    AppModule.forRoot(config, logger).imports.includes(MockCheckoutModule),
  );
  const other = { ...config, PAYMENT_PROVIDER: 'other' };
  assert.equal(
    AppModule.forRoot(other, logger).imports.includes(MockCheckoutModule),
    false,
  );
});
