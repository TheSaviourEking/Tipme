import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadApiConfig } from '../dist/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
  STATUS_TOKEN_SECRET: 's'.repeat(32),
  AUTH_CODE_SECRET: 'a'.repeat(32),
  WEB_REVALIDATE_SECRET: 'r'.repeat(32),
  OPS_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'),
  MAIL_SEAL_KEY: Buffer.alloc(32, 2).toString('base64'),
};

test('the mock provider can never run in production', () => {
  assert.throws(
    () => loadApiConfig({ ...base, NODE_ENV: 'production' }),
    /PAYMENT_PROVIDER/,
  );
});

test('live payments cannot be switched on', () => {
  assert.throws(
    () =>
      loadApiConfig({
        ...base,
        NODE_ENV: 'development',
        PAYMENTS_LIVE_ENABLED: 'true',
      }),
    /PAYMENTS_LIVE_ENABLED/,
  );
});

test('the mock needs a webhook secret of at least 32 characters', () => {
  assert.throws(
    () =>
      loadApiConfig({
        ...base,
        NODE_ENV: 'development',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'short',
      }),
    /MOCK_PROVIDER_WEBHOOK_SECRET/,
  );
  assert.equal(
    loadApiConfig({ ...base, NODE_ENV: 'development' }).PAYMENT_PROVIDER,
    'mock',
  );
});

test('the pretend messenger can never run in production', () => {
  assert.throws(
    () =>
      loadApiConfig({
        ...base,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: undefined,
        MESSAGING_PROVIDER: 'mock',
      }),
    /MESSAGING_PROVIDER/,
  );
});
