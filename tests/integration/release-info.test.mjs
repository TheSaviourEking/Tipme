import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReleaseInfoController } from '../../apps/api/dist/release/release.controller.js';

const info = (config) =>
  new ReleaseInfoController(
    {
      RELEASE_KIND: 'test',
      DEPLOYMENT_MODE: 'preview',
      NODE_ENV: 'production',
      ...config,
    },
    {},
  ).info().data;

test('a copy names its payment provider, so the release check knows which tip it can complete', () => {
  assert.equal(info({ PAYMENT_PROVIDER: 'mock' }).paymentProvider, 'mock');
  assert.equal(
    info({ PAYMENT_PROVIDER: 'bachs-sandbox' }).paymentProvider,
    'bachs-sandbox',
  );
});

test('a copy says whether TipMe for businesses is on, so the web invites people to create one', () => {
  assert.equal(info({ BUSINESS_ENABLED: true }).business, true);
  assert.equal(info({ BUSINESS_ENABLED: false }).business, false);
});
