import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '@tipme/observability';
import { loadApiConfig } from '../dist/config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
  STATUS_TOKEN_SECRET: 's'.repeat(32),
  AUTH_CODE_SECRET: 'a'.repeat(32),
  WEB_REVALIDATE_SECRET: 'r'.repeat(32),
  OPS_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'),
  MAIL_SEAL_KEY: Buffer.alloc(32, 2).toString('base64'),
};

test('missing connection settings are named', () => {
  assert.throws(
    () => loadApiConfig({}),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(
        error.message,
        'Invalid configuration: AUTH_CODE_SECRET, DATABASE_URL, MAIL_SEAL_KEY, OPS_TOTP_KEY, REDIS_URL, STATUS_TOKEN_SECRET, WEB_REVALIDATE_SECRET',
      );
      return true;
    },
  );
});

test('diagnostics can never be enabled in production', () => {
  assert.throws(
    () =>
      loadApiConfig({
        ...valid,
        NODE_ENV: 'production',
        DIAGNOSTICS_ENABLED: 'true',
      }),
    /DIAGNOSTICS_ENABLED/,
  );
});

test('valid settings are parsed with safe defaults', () => {
  const config = loadApiConfig({
    ...valid,
    NODE_ENV: 'development',
    PORT: '4100',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
  });
  assert.equal(config.PORT, 4100);
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.DIAGNOSTICS_ENABLED, false);
  assert.equal(config.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.equal(
    loadApiConfig({
      ...valid,
      NODE_ENV: 'development',
      DIAGNOSTICS_ENABLED: 'false',
    }).DIAGNOSTICS_ENABLED,
    false,
  );
});

test('diagnostics fail closed when NODE_ENV is not set', () => {
  assert.throws(
    () => loadApiConfig({ ...valid, DIAGNOSTICS_ENABLED: 'true' }),
    /DIAGNOSTICS_ENABLED/,
  );
  // Unset NODE_ENV means production, where the mock provider is refused too: startup fails closed.
  assert.throws(() => loadApiConfig(valid), /PAYMENT_PROVIDER/);
});

test('explicit hosted preview permits mocks but requires a strong gate and HTTPS', () => {
  const preview = {
    ...valid,
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'preview',
    PREVIEW_PASSWORD: 'p'.repeat(32),
    WEB_ORIGIN: 'https://tipme-demo.onrender.com',
  };
  assert.equal(loadApiConfig(preview).DEPLOYMENT_MODE, 'preview');
  for (const override of [
    { PREVIEW_PASSWORD: '' },
    { WEB_ORIGIN: 'http://example.com' },
    { PAYMENTS_LIVE_ENABLED: 'true' },
    { DIAGNOSTICS_ENABLED: 'true' },
  ]) {
    assert.throws(() => loadApiConfig({ ...preview, ...override }));
  }
  assert.throws(
    () => loadApiConfig({ ...preview, DEPLOYMENT_MODE: 'production' }),
    /PAYMENT_PROVIDER/,
  );
});

test('a container may bind every interface; a copy is live unless it says test (PR-010)', () => {
  const config = loadApiConfig({ ...valid, NODE_ENV: 'test', HOST: '0.0.0.0' });
  assert.equal(config.HOST, '0.0.0.0');
  assert.equal(config.RELEASE_KIND, 'live');
  assert.equal(
    loadApiConfig({ ...valid, NODE_ENV: 'test', RELEASE_KIND: 'test' })
      .RELEASE_KIND,
    'test',
  );
  assert.throws(() =>
    loadApiConfig({ ...valid, NODE_ENV: 'test', HOST: '10.0.0.5' }),
  );
  assert.throws(() =>
    loadApiConfig({ ...valid, NODE_ENV: 'test', RELEASE_KIND: 'staging' }),
  );
  assert.throws(() =>
    loadApiConfig({ ...valid, NODE_ENV: 'test', RELEASE_CHECK_TOKEN: 'short' }),
  );
});

test('Bachs sandbox is selectable in test and preview only, never production', () => {
  const bachs = {
    ...valid,
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_test',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
    // Bachs sends supporters back to the web app, so it must be public.
    WEB_ORIGIN: 'https://tipme-tunnel.example.com',
  };
  assert.equal(
    loadApiConfig({ ...bachs, NODE_ENV: 'test' }).PAYMENT_PROVIDER,
    'bachs-sandbox',
  );
  assert.equal(
    loadApiConfig({
      ...bachs,
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'preview',
      RELEASE_KIND: 'test',
      PREVIEW_PASSWORD: 'p'.repeat(32),
      WEB_ORIGIN: 'https://tipme-demo.example.com',
    }).PAYMENT_PROVIDER,
    'bachs-sandbox',
  );
  assert.throws(
    () => loadApiConfig({ ...bachs, NODE_ENV: 'production' }),
    /PAYMENT_PROVIDER/,
  );
  assert.throws(() =>
    loadApiConfig({
      ...bachs,
      NODE_ENV: 'test',
      BACHS_SANDBOX_API_KEY: undefined,
    }),
  );
});

test('the Bachs sandbox refuses a local web address, because Bachs cannot send supporters back to it', () => {
  for (const WEB_ORIGIN of [
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://app.localhost:3000',
  ])
    assert.throws(
      () =>
        loadApiConfig({
          ...valid,
          NODE_ENV: 'test',
          PAYMENT_PROVIDER: 'bachs-sandbox',
          BACHS_SANDBOX_API_KEY: 'sk_sandbox_test',
          BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
          WEB_ORIGIN,
        }),
      /WEB_ORIGIN/,
      WEB_ORIGIN,
    );
  // The mock provider keeps working locally.
  assert.equal(
    loadApiConfig({
      ...valid,
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
    }).PAYMENT_PROVIDER,
    'mock',
  );
});

test('sign-in codes stay at 3 per number per hour unless a copy raises it (PR-010)', () => {
  assert.equal(
    loadApiConfig({ ...valid, NODE_ENV: 'test' })
      .RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR,
    3,
  );
  assert.throws(() =>
    loadApiConfig({
      ...valid,
      NODE_ENV: 'test',
      RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR: '1000',
    }),
  );
});

test('the pretend mail provider is refused in production, allowed in preview', () => {
  const production = {
    ...valid,
    NODE_ENV: 'production',
    PAYMENT_PROVIDER: 'bachs-sandbox',
    DEPLOYMENT_MODE: 'preview',
    PREVIEW_PASSWORD: 'p'.repeat(32),
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_test',
    BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
    WEB_ORIGIN: 'https://staging.usetipme.xyz',
    MAIL_DEFAULT_PROVIDER: 'mock',
  };
  assert.equal(loadApiConfig(production).MAIL_DEFAULT_PROVIDER, 'mock');
  assert.throws(
    () =>
      loadApiConfig({
        ...production,
        DEPLOYMENT_MODE: 'production',
        PAYMENT_PROVIDER: 'mock',
      }),
    /MAIL_DEFAULT_PROVIDER/,
  );
});

test('point-in-time recovery is expected unless switched off (staging keeps only nightly dumps)', () => {
  assert.equal(
    loadApiConfig({ ...valid, NODE_ENV: 'test' }).POINT_IN_TIME_RECOVERY,
    true,
  );
  assert.equal(
    loadApiConfig({ ...valid, NODE_ENV: 'test', POINT_IN_TIME_RECOVERY: 'off' })
      .POINT_IN_TIME_RECOVERY,
    false,
  );
  assert.throws(() =>
    loadApiConfig({
      ...valid,
      NODE_ENV: 'test',
      POINT_IN_TIME_RECOVERY: 'maybe',
    }),
  );
});
