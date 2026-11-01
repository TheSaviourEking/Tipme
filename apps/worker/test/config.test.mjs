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

test('a single sender address is optional and must be an address', () => {
  const base = {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  };
  assert.equal(loadWorkerConfig(base).MAIL_FROM_ADDRESS, undefined);
  assert.equal(
    loadWorkerConfig({ ...base, MAIL_FROM_ADDRESS: 'staging@usetipme.xyz' })
      .MAIL_FROM_ADDRESS,
    'staging@usetipme.xyz',
  );
  assert.throws(() =>
    loadWorkerConfig({ ...base, MAIL_FROM_ADDRESS: 'not an address' }),
  );
});

test('pretend domains are a lowercase list, empty by default', () => {
  const base = {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  };
  assert.deepEqual(loadWorkerConfig(base).MAIL_PRETEND_DOMAINS, []);
  assert.deepEqual(
    loadWorkerConfig({
      ...base,
      MAIL_PRETEND_DOMAINS: ' Release-Check.UseTipMe.xyz , qa.example ',
    }).MAIL_PRETEND_DOMAINS,
    ['release-check.usetipme.xyz', 'qa.example'],
  );
});

test('in production, the worker too needs TLS with a checked certificate for a remote database', () => {
  const load = (DATABASE_URL) => {
    try {
      loadWorkerConfig({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://127.0.0.1:6379',
        DATABASE_URL,
        MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
      });
      return '';
    } catch (error) {
      return error.message;
    }
  };
  const remote = 'postgres://u:p@tipme-db.aivencloud.com:23456/tipme';
  assert.match(load(remote), /DATABASE_URL/);
  assert.doesNotMatch(load(`${remote}?sslmode=verify-full`), /DATABASE_URL/);
});

// A production copy: DEPLOYMENT_MODE=production and NODE_ENV=production, with the live provider
// (payments switched off) and a dummy live key. Each test adds one setting and checks it is named.
const productionBase = {
  DEPLOYMENT_MODE: 'production',
  NODE_ENV: 'production',
  PAYMENT_PROVIDER: 'bachs-live',
  BACHS_LIVE_API_KEY: 'sk_live_dummy_key_value',
  MAIL_DEFAULT_PROVIDER: 'ses',
  SES_CONFIGURATION_SET: 'tipme-tracked',
  SES_CONFIGURATION_SET_UNTRACKED: 'tipme-untracked',
  SES_SNS_TOPIC_ARN: 'arn:aws:sns:eu-north-1:123456789012:tipme-ses',
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL:
    'postgres://u:p@tipme-db.aivencloud.com:23456/tipme?sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem',
  MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
};
const productionIssues = (extra) => {
  try {
    loadWorkerConfig({ ...productionBase, ...extra });
    return '';
  } catch (error) {
    return error.message;
  }
};

test('the production base loads', () => {
  assert.equal(productionIssues({}), '');
  const config = loadWorkerConfig(productionBase);
  assert.equal(config.PAYMENT_PROVIDER, 'bachs-live');
  assert.equal(config.PAYMENTS_LIVE_ENABLED, false);
});

test('production refuses mock and sandbox, and live payments need bachs-live and its key', () => {
  assert.match(
    productionIssues({ PAYMENT_PROVIDER: 'mock' }),
    /PAYMENT_PROVIDER/,
  );
  assert.match(
    productionIssues({ PAYMENT_PROVIDER: 'bachs-sandbox' }),
    /PAYMENT_PROVIDER/,
  );
  // Live payments stay fenced until payouts land (Task 12).
  assert.match(
    productionIssues({ PAYMENTS_LIVE_ENABLED: 'true' }),
    /PAYMENTS_LIVE_ENABLED/,
  );
  assert.match(
    productionIssues({ BACHS_LIVE_API_KEY: undefined }),
    /BACHS_LIVE_API_KEY/,
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

test('production refuses RELEASE_KIND=test', () => {
  assert.match(productionIssues({ RELEASE_KIND: 'test' }), /RELEASE_KIND/);
});

test('a preview copy keeps these settings', () => {
  const config = loadWorkerConfig({
    ...productionBase,
    DEPLOYMENT_MODE: 'preview',
    PREVIEW_PASSWORD: 'p'.repeat(32),
    PAYMENT_PROVIDER: 'bachs-sandbox',
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_test',
    BACHS_LIVE_API_KEY: undefined,
    RELEASE_KIND: 'test',
    MAIL_PRETEND_DOMAINS: 'release-check.usetipme.xyz',
  });
  assert.equal(config.RELEASE_KIND, 'test');
});

test('a production copy has no pretend cash reward budget (D-05)', () => {
  assert.equal(
    loadWorkerConfig(productionBase).REWARD_CASH_BUDGET_MINOR_PER_MONTH,
    0n,
  );
  assert.equal(
    loadWorkerConfig({
      ...productionBase,
      REWARD_CASH_BUDGET_MINOR_PER_MONTH: '0',
    }).REWARD_CASH_BUDGET_MINOR_PER_MONTH,
    0n,
  );
  const message = productionIssues({
    REWARD_CASH_BUDGET_MINOR_PER_MONTH: '1000',
  });
  assert.match(message, /REWARD_CASH_BUDGET_MINOR_PER_MONTH/);
  assert.doesNotMatch(message, /1000/);
});

test('a preview copy keeps the default cash reward budget', () => {
  const preview = {
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'preview',
    PREVIEW_PASSWORD: 'p'.repeat(32),
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATABASE_URL: 'postgres://u:p@localhost/db',
    MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  };
  assert.equal(
    loadWorkerConfig(preview).REWARD_CASH_BUDGET_MINOR_PER_MONTH,
    25_000_000n,
  );
});

const reserveBase = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
  MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
  NODE_ENV: 'test',
};

test('the reserve alert level is ₦1,000 unless set, and the alert route is optional', () => {
  const config = loadWorkerConfig(reserveBase);
  assert.equal(config.BACHS_RESERVE_ALERT_MINOR, 100000n);
  assert.equal(config.ALERT_WEBHOOK_URL, undefined);
  const set = loadWorkerConfig({
    ...reserveBase,
    BACHS_RESERVE_ALERT_MINOR: '250000',
    ALERT_WEBHOOK_URL: 'https://hooks.example.test/services/T0/B0/token',
  });
  assert.equal(set.BACHS_RESERVE_ALERT_MINOR, 250000n);
  assert.equal(
    set.ALERT_WEBHOOK_URL,
    'https://hooks.example.test/services/T0/B0/token',
  );
  // An empty value (common in .env files) means not set.
  const blank = loadWorkerConfig({
    ...reserveBase,
    BACHS_RESERVE_ALERT_MINOR: '',
    ALERT_WEBHOOK_URL: '',
  });
  assert.equal(blank.BACHS_RESERVE_ALERT_MINOR, 100000n);
  assert.equal(blank.ALERT_WEBHOOK_URL, undefined);
});

test('a bad reserve level or alert route is refused by name, never by value', () => {
  for (const bad of ['abc', '-1', '1.5', '1e5', '0', '007'])
    assert.throws(
      () =>
        loadWorkerConfig({ ...reserveBase, BACHS_RESERVE_ALERT_MINOR: bad }),
      { message: 'Invalid configuration: BACHS_RESERVE_ALERT_MINOR' },
      bad,
    );
  const secret = 'ftp://hooks.example.test/services/T0/B0/very-secret-token';
  assert.throws(
    () => loadWorkerConfig({ ...reserveBase, ALERT_WEBHOOK_URL: secret }),
    (error) =>
      error.message === 'Invalid configuration: ALERT_WEBHOOK_URL' &&
      !String(error.stack).includes('very-secret-token'),
  );
});

test('in production the alert route must be https', () => {
  assert.equal(
    productionIssues({
      ALERT_WEBHOOK_URL: 'https://hooks.example.test/T0/B0/x',
    }),
    '',
  );
  assert.match(
    productionIssues({
      ALERT_WEBHOOK_URL: 'http://hooks.example.test/T0/B0/x',
    }),
    /ALERT_WEBHOOK_URL/,
  );
  // Outside production a local http stand-in is fine.
  const local = loadWorkerConfig({
    ...reserveBase,
    ALERT_WEBHOOK_URL: 'http://127.0.0.1:9999/hook',
  });
  assert.equal(local.ALERT_WEBHOOK_URL, 'http://127.0.0.1:9999/hook');
});

test('with live payments on, production will not start without an alert route; with them off it does', () => {
  // Off (as today, while checkout is closed): no address needed, the worker only warns.
  assert.equal(productionIssues({}), '');
  assert.equal(productionIssues({ PAYMENTS_LIVE_ENABLED: 'false' }), '');
  // On: the address is required (the fence names PAYMENTS_LIVE_ENABLED as well until Task 12).
  assert.match(
    productionIssues({ PAYMENTS_LIVE_ENABLED: 'true' }),
    /ALERT_WEBHOOK_URL/,
  );
  assert.doesNotMatch(
    productionIssues({
      PAYMENTS_LIVE_ENABLED: 'true',
      ALERT_WEBHOOK_URL: 'https://hooks.example.test/T0/B0/x',
    }),
    /ALERT_WEBHOOK_URL/,
  );
  // The message names the setting, never a value.
  assert.doesNotMatch(
    productionIssues({
      PAYMENTS_LIVE_ENABLED: 'true',
      ALERT_WEBHOOK_URL: 'http://hooks.example.test/T0/B0/very-secret-token',
    }),
    /very-secret-token/,
  );
});
