import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkerConfig } from '../dist/config.js';

test('missing Redis and database addresses are named', () => {
  assert.throws(() => loadWorkerConfig({}), {
    message: 'Invalid configuration: DATABASE_URL, REDIS_URL',
  });
});

test('the test-only job delay is refused outside tests', () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        REDIS_URL: 'redis://127.0.0.1:6379',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
        TRACE_PROBE_TEST_DELAY_MS: '500',
      }),
    /TRACE_PROBE_TEST_DELAY_MS/,
  );
  const config = loadWorkerConfig({
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
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
  });
  assert.equal(config.PAYMENT_PROVIDER, 'mock');
});

test('an unset NODE_ENV counts as production, so the mock is refused', () => {
  assert.throws(
    () =>
      loadWorkerConfig({
        REDIS_URL: 'redis://127.0.0.1:6379',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
      }),
    /PAYMENT_PROVIDER/,
  );
});

test('hosted preview is explicit and never enables live payments', () => {
  const preview = { NODE_ENV: 'production', DEPLOYMENT_MODE: 'preview', PREVIEW_PASSWORD: 'p'.repeat(32), REDIS_URL: 'redis://127.0.0.1:6379', DATABASE_URL: 'postgres://u:p@localhost/db' };
  assert.equal(loadWorkerConfig(preview).DEPLOYMENT_MODE, 'preview');
  assert.throws(() => loadWorkerConfig({ ...preview, PREVIEW_PASSWORD: '' }));
  assert.throws(() => loadWorkerConfig({ ...preview, PAYMENTS_LIVE_ENABLED: 'true' }));
  assert.throws(() => loadWorkerConfig({ ...preview, DEPLOYMENT_MODE: 'production' }), /PAYMENT_PROVIDER/);
});
