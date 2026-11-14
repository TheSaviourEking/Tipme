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

test('R2 photo storage needs all four settings or none', () => {
  const test = { ...valid, NODE_ENV: 'test' };
  assert.equal(loadApiConfig(test).R2_BUCKET, undefined);
  const r2 = {
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'tipme-photos',
  };
  assert.equal(loadApiConfig({ ...test, ...r2 }).R2_BUCKET, 'tipme-photos');
  assert.throws(
    () => loadApiConfig({ ...test, R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'b' }),
    /R2_ACCESS_KEY_ID/,
  );
});

const production = (DATABASE_URL) => {
  try {
    loadApiConfig({ ...valid, NODE_ENV: 'production', DATABASE_URL });
    return '';
  } catch (error) {
    return error.message;
  }
};

test('in production, a database across the network needs TLS with its certificate checked', () => {
  // Production refuses the pretend payment provider here too; only the database part is checked.
  const remote =
    'postgres://tipme_runtime:p@tipme-db-project.aivencloud.com:23456/tipme';
  assert.match(production(remote), /DATABASE_URL/);
  assert.match(production(`${remote}?sslmode=require`), /DATABASE_URL/);
  assert.doesNotMatch(
    production(
      `${remote}?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem`,
    ),
    /DATABASE_URL/,
  );
  assert.doesNotMatch(
    production(`${remote}?sslmode=verify-ca`),
    /DATABASE_URL/,
  );
  // A database on the same host or Docker network may connect without TLS.
  assert.doesNotMatch(
    production('postgres://u:p@postgres:5432/tipme'),
    /DATABASE_URL/,
  );
  assert.doesNotMatch(
    production('postgres://u:p@127.0.0.1:5432/tipme'),
    /DATABASE_URL/,
  );
});

test('outside production, a remote database without TLS is allowed (tests and staging)', () => {
  assert.equal(
    loadApiConfig({
      ...valid,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/tipme',
    }).DATABASE_URL,
    'postgres://u:p@db.example.com:5432/tipme',
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

// A production copy: DEPLOYMENT_MODE=production and NODE_ENV=production, with the live provider
// (payments switched off) and dummy live credentials. Each test adds one setting and checks it
// is named.
const productionBase = {
  ...valid,
  DEPLOYMENT_MODE: 'production',
  NODE_ENV: 'production',
  PAYMENT_PROVIDER: 'bachs-live',
  BACHS_LIVE_API_KEY: 'sk_live_dummy_key_value',
  BACHS_LIVE_WEBHOOK_SECRET: 'l'.repeat(32),
  WEB_ORIGIN: 'https://usetipme.xyz',
  MAIL_DEFAULT_PROVIDER: 'ses',
  SES_CONFIGURATION_SET: 'tipme-tracked',
  SES_CONFIGURATION_SET_UNTRACKED: 'tipme-untracked',
  SES_SNS_TOPIC_ARN: 'arn:aws:sns:eu-north-1:123456789012:tipme-ses',
  DATABASE_URL:
    'postgres://u:p@tipme-db.aivencloud.com:23456/tipme?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem',
};
const productionIssues = (extra) => {
  try {
    loadApiConfig({ ...productionBase, ...extra });
    return '';
  } catch (error) {
    return error.message;
  }
};

test('the production base loads', () => {
  assert.equal(productionIssues({}), '');
  const config = loadApiConfig(productionBase);
  assert.equal(config.PAYMENT_PROVIDER, 'bachs-live');
  assert.equal(config.PAYMENTS_LIVE_ENABLED, false);
});

test('production refuses mock and sandbox, and sandbox credentials beside bachs-live', () => {
  assert.match(
    productionIssues({ PAYMENT_PROVIDER: 'mock' }),
    /PAYMENT_PROVIDER/,
  );
  assert.match(
    productionIssues({ PAYMENT_PROVIDER: 'bachs-sandbox' }),
    /PAYMENT_PROVIDER/,
  );
  assert.match(
    productionIssues({ BACHS_SANDBOX_API_KEY: 'sk_sandbox_test' }),
    /BACHS_SANDBOX_API_KEY/,
  );
});

test('production takes live payments only with the live key and webhook secret; other copies refuse bachs-live', () => {
  assert.equal(productionIssues({ PAYMENTS_LIVE_ENABLED: 'true' }), '');
  assert.equal(
    loadApiConfig({ ...productionBase, PAYMENTS_LIVE_ENABLED: 'true' })
      .PAYMENTS_LIVE_ENABLED,
    true,
  );
  for (const missing of ['BACHS_LIVE_API_KEY', 'BACHS_LIVE_WEBHOOK_SECRET'])
    assert.match(
      productionIssues({ PAYMENTS_LIVE_ENABLED: 'true', [missing]: undefined }),
      new RegExp(missing),
    );
  assert.match(
    productionIssues({ BACHS_LIVE_API_KEY: undefined }),
    /BACHS_LIVE_API_KEY/,
  );
  assert.match(
    productionIssues({ BACHS_LIVE_WEBHOOK_SECRET: undefined }),
    /BACHS_LIVE_WEBHOOK_SECRET/,
  );
  assert.throws(
    () => loadApiConfig({ ...productionBase, NODE_ENV: 'test' }),
    /PAYMENT_PROVIDER/,
  );
});

test('bachs-live on a production copy needs a public https web address', () => {
  // Bachs sends supporters back to WEB_ORIGIN; unset, it would default to localhost.
  for (const WEB_ORIGIN of [undefined, 'http://localhost:3000']) {
    const issues = productionIssues({ WEB_ORIGIN });
    assert.match(issues, /WEB_ORIGIN/, String(WEB_ORIGIN));
  }
  assert.match(
    productionIssues({ WEB_ORIGIN: 'https://localhost' }),
    /WEB_ORIGIN/,
  );
  assert.match(
    productionIssues({ WEB_ORIGIN: 'http://usetipme.xyz' }),
    /WEB_ORIGIN/,
  );
  assert.equal(productionIssues({ WEB_ORIGIN: 'https://usetipme.xyz' }), '');
  assert.equal(
    loadApiConfig({ ...productionBase, WEB_ORIGIN: 'https://usetipme.xyz' })
      .WEB_ORIGIN,
    'https://usetipme.xyz',
  );
});

test('production refuses a preview password', () => {
  assert.match(
    productionIssues({ PREVIEW_PASSWORD: 'x'.repeat(32) }),
    /PREVIEW_PASSWORD/,
  );
});

test('production refuses pretend mail domains', () => {
  assert.match(
    productionIssues({ MAIL_PRETEND_DOMAINS: 'release-check.usetipme.xyz' }),
    /MAIL_PRETEND_DOMAINS/,
  );
});

test('production refuses RELEASE_KIND=test and a release-check token', () => {
  assert.match(productionIssues({ RELEASE_KIND: 'test' }), /RELEASE_KIND/);
  assert.match(
    productionIssues({ RELEASE_CHECK_TOKEN: 'x'.repeat(32) }),
    /RELEASE_CHECK_TOKEN/,
  );
});

test('preview and test copies keep these settings', () => {
  const preview = {
    ...valid,
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'preview',
    PREVIEW_PASSWORD: 'p'.repeat(32),
    WEB_ORIGIN: 'https://staging.usetipme.xyz',
    RELEASE_KIND: 'test',
    RELEASE_CHECK_TOKEN: 'x'.repeat(32),
    MAIL_PRETEND_DOMAINS: 'release-check.usetipme.xyz',
  };
  const config = loadApiConfig(preview);
  assert.equal(config.RELEASE_KIND, 'test');
});

test('LIVE_UPDATES_ENABLED defaults to false; true turns it on; LIVE_MAX_STREAMS defaults to 2000', () => {
  const off = loadApiConfig({ ...valid, NODE_ENV: 'development' });
  assert.equal(off.LIVE_UPDATES_ENABLED, false);
  assert.equal(off.LIVE_MAX_STREAMS, 2000);
  assert.equal(off.LIVE_HEARTBEAT_MS, 20000);
  assert.equal(
    loadApiConfig({
      ...valid,
      NODE_ENV: 'development',
      LIVE_UPDATES_ENABLED: 'true',
    }).LIVE_UPDATES_ENABLED,
    true,
  );
  assert.throws(
    () =>
      loadApiConfig({
        ...valid,
        NODE_ENV: 'development',
        LIVE_UPDATES_ENABLED: 'yes',
      }),
    /LIVE_UPDATES_ENABLED/,
  );
  assert.throws(
    () =>
      loadApiConfig({
        ...valid,
        NODE_ENV: 'development',
        LIVE_HEARTBEAT_MS: '999',
      }),
    /LIVE_HEARTBEAT_MS/,
  );
});

test('BUSINESS_SHARES_ENABLED and TEAM_TIPS_ENABLED default to false; true turns each on alone', () => {
  const off = loadApiConfig({ ...valid, NODE_ENV: 'development' });
  assert.equal(off.BUSINESS_SHARES_ENABLED, false);
  assert.equal(off.TEAM_TIPS_ENABLED, false);
  const shares = loadApiConfig({
    ...valid,
    NODE_ENV: 'development',
    BUSINESS_SHARES_ENABLED: 'true',
  });
  assert.equal(shares.BUSINESS_SHARES_ENABLED, true);
  assert.equal(shares.TEAM_TIPS_ENABLED, false);
  for (const name of ['BUSINESS_SHARES_ENABLED', 'TEAM_TIPS_ENABLED'])
    assert.throws(
      () => loadApiConfig({ ...valid, NODE_ENV: 'development', [name]: 'yes' }),
      new RegExp(name),
    );
});

test('the changelog signing secret is optional, at least 32 characters, and blank means off', () => {
  const dev = { ...valid, NODE_ENV: 'development' };
  assert.equal(loadApiConfig(dev).CHANGELOG_SIGNING_SECRET, undefined);
  assert.equal(
    loadApiConfig({ ...dev, CHANGELOG_SIGNING_SECRET: '' })
      .CHANGELOG_SIGNING_SECRET,
    undefined,
  );
  assert.equal(
    loadApiConfig({ ...dev, CHANGELOG_SIGNING_SECRET: 'c'.repeat(32) })
      .CHANGELOG_SIGNING_SECRET,
    'c'.repeat(32),
  );
  assert.throws(
    () => loadApiConfig({ ...dev, CHANGELOG_SIGNING_SECRET: 'short' }),
    /CHANGELOG_SIGNING_SECRET/,
  );
});

test('anonymous analytics is on in production unless set to false (owner, 9 Nov 2026; D-07 open)', () => {
  const production = {
    ...valid,
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'preview',
    PREVIEW_PASSWORD: 'p'.repeat(32),
    WEB_ORIGIN: 'https://tipme-demo.onrender.com',
  };
  assert.equal(loadApiConfig(production).ANALYTICS_ENABLED, true);
  assert.equal(
    loadApiConfig({ ...production, ANALYTICS_ENABLED: 'false' })
      .ANALYTICS_ENABLED,
    false,
  );
  assert.equal(
    loadApiConfig({ ...valid, NODE_ENV: 'test' }).ANALYTICS_ENABLED,
    true,
  );
});

test('PAGE_STUDIO_ENABLED (Page Studio) defaults to false; only "true" turns it on', () => {
  const env = { ...valid, NODE_ENV: 'development' };
  assert.equal(loadApiConfig(env).PAGE_STUDIO_ENABLED, false);
  assert.equal(
    loadApiConfig({ ...env, PAGE_STUDIO_ENABLED: 'true' }).PAGE_STUDIO_ENABLED,
    true,
  );
  assert.throws(
    () => loadApiConfig({ ...env, PAGE_STUDIO_ENABLED: 'on' }),
    /PAGE_STUDIO_ENABLED/,
  );
});
