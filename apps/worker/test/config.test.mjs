import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkerConfig } from '../dist/config.js';

test('missing Redis and database addresses are named', () => {
  assert.throws(() => loadWorkerConfig({}), {
    message: 'Invalid configuration: DATABASE_URL, MAIL_SEAL_KEY, REDIS_URL',
  });
});

test('the test-only job delay is refused outside tests', () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        REDIS_URL: 'redis://127.0.0.1:6379',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
        MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
        MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
        TRACE_PROBE_TEST_DELAY_MS: '500',
      }),
    /TRACE_PROBE_TEST_DELAY_MS/,
  );
  const config = loadWorkerConfig({
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
    MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
    NODE_ENV: 'test',
    TRACE_PROBE_TEST_DELAY_MS: '500',
  });
  assert.equal(config.TRACE_PROBE_TEST_DELAY_MS, 500);
  assert.equal(config.QUEUE_PREFIX, 'tipme');
});

test('the mock provider can never run in production', () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        REDIS_URL: 'redis://127.0.0.1:6379',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
        MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
        MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
        NODE_ENV: 'production',
      }),
    /PAYMENT_PROVIDER/,
  );
});

test('the worker does not need the webhook secret', () => {
  const config = loadWorkerConfig({
    NODE_ENV: 'development',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  });
  assert.equal(config.PAYMENT_PROVIDER, 'mock');
});

test('an unset NODE_ENV counts as production, so the mock is refused', () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        REDIS_URL: 'redis://127.0.0.1:6379',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
        MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
        MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
      }),
    /PAYMENT_PROVIDER/,
  );
});

test('hosted preview is explicit and never enables live payments', () => {
  const preview = {
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'preview',
    PREVIEW_PASSWORD: 'p'.repeat(32),
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@localhost/db',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  };
  assert.equal(loadWorkerConfig(preview).DEPLOYMENT_MODE, 'preview');
  assert.throws(() => loadWorkerConfig({ ...preview, PREVIEW_PASSWORD: '' }));
  assert.throws(() =>
    loadWorkerConfig({ ...preview, PAYMENTS_LIVE_ENABLED: 'true' }),
  );
  assert.throws(
    () => loadWorkerConfig({ ...preview, DEPLOYMENT_MODE: 'production' }),
    /PAYMENT_PROVIDER/,
  );
});

test('Bachs sandbox is selectable in test and preview only, never production', () => {
  const base = {
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_test',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
  };
  assert.equal(
    loadWorkerConfig({ ...base, NODE_ENV: 'test', RELEASE_KIND: 'test' })
      .PAYMENT_PROVIDER,
    'bachs-sandbox',
  );
  assert.throws(
    () =>
      loadWorkerConfig({
        ...base,
        NODE_ENV: 'production',
        DEPLOYMENT_MODE: 'production',
      }),
    /PAYMENT_PROVIDER/,
  );
  assert.throws(
    () =>
      loadWorkerConfig({
        ...base,
        NODE_ENV: 'test',
        BACHS_SANDBOX_API_KEY: undefined,
      }),
    /BACHS_SANDBOX_API_KEY/,
  );
  assert.throws(() =>
    loadWorkerConfig({
      ...base,
      NODE_ENV: 'test',
      PAYMENTS_LIVE_ENABLED: 'true',
    }),
  );
});

test('the worker reads Bachs with its API key alone and never needs or accepts webhook secrets', () => {
  const config = loadWorkerConfig({
    NODE_ENV: 'test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
    MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_worker_only',
  });
  assert.equal(config.BACHS_SANDBOX_API_KEY, 'sk_sandbox_worker_only');
  assert.equal('BACHS_WEBHOOK_SECRET' in config, false);
});

test('the mail seal key must be 32 bytes', () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        REDIS_URL: 'redis://127.0.0.1:6379',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
        MAIL_SEAL_KEY: Buffer.alloc(16, 5).toString('base64'),
      }),
    /MAIL_SEAL_KEY/,
  );
});

test('the pretend mail provider is refused in production', () => {
  const production = {
    NODE_ENV: 'production',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
    PAYMENT_PROVIDER: 'bachs-sandbox',
  };
  assert.throws(
    () => loadWorkerConfig({ ...production, MAIL_DEFAULT_PROVIDER: 'mock' }),
    /MAIL_DEFAULT_PROVIDER/,
  );
});

test('mail defaults: pretend provider, TipMe sender, no reply-to', () => {
  const config = loadWorkerConfig({
    NODE_ENV: 'test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  });
  assert.equal(config.MAIL_DEFAULT_PROVIDER, 'mock');
  assert.equal(config.MAIL_FROM_DOMAIN, 'mail.usetipme.xyz');
  assert.equal(config.MAIL_FROM_NAME, 'TipMe');
  assert.equal(config.MAIL_REPLY_TO, undefined);
});
