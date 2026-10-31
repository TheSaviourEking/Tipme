import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  bachsEnvironment,
  checkPaymentSettings,
  isLiveProvider,
  paymentSettingsShape,
  paymentWebhookSettingsShape,
} from '../dist/index.js';

// One definition of the payment settings for the API and the worker. Messages name settings and
// never show values.

const LIVE_KEY = 'sk_live_dummy_key_value';
const LIVE_SECRET = 'l'.repeat(32);

const schema = (webhooks) =>
  z
    .object({
      NODE_ENV: z.string().default('test'),
      DEPLOYMENT_MODE: z.string().default('production'),
      ...paymentSettingsShape,
      ...(webhooks ? paymentWebhookSettingsShape : {}),
    })
    .superRefine((config, context) =>
      checkPaymentSettings(config, context, { webhooks }),
    );
const issues = (env, webhooks = true) => {
  const result = schema(webhooks).safeParse(env);
  return result.success ? [] : result.error.issues;
};
const paths = (env, webhooks) =>
  issues(env, webhooks).map((issue) => issue.path.join('.'));

const liveCredentials = {
  BACHS_LIVE_API_KEY: LIVE_KEY,
  BACHS_LIVE_WEBHOOK_SECRET: LIVE_SECRET,
};
const sandboxCredentials = {
  BACHS_SANDBOX_API_KEY: 'sk_sandbox_dummy',
  BACHS_WEBHOOK_SECRET: 'b'.repeat(32),
};

const cases = [
  // [mode, nodeEnv, provider, live, ok]
  ['production', 'production', 'bachs-live', 'true', true],
  ['production', 'production', 'bachs-live', 'false', true],
  ['production', 'production', 'bachs-sandbox', 'false', false],
  ['production', 'production', 'mock', 'false', false],
  ['production', 'production', 'mock', 'true', false],
  ['preview', 'production', 'bachs-live', 'false', false],
  ['preview', 'production', 'bachs-sandbox', 'false', true],
  ['preview', 'production', 'bachs-sandbox', 'true', false],
  ['production', 'test', 'bachs-live', 'false', false],
];
for (const [mode, nodeEnv, provider, live, ok] of cases) {
  test(`${mode}/${nodeEnv} with ${provider} and live=${live} is ${ok ? 'accepted' : 'refused'}`, () => {
    // Credentials that belong to the provider, so only the combination is judged.
    const credentials =
      provider === 'bachs-live'
        ? liveCredentials
        : provider === 'bachs-sandbox'
          ? sandboxCredentials
          : {};
    const found = issues({
      DEPLOYMENT_MODE: mode,
      NODE_ENV: nodeEnv,
      PAYMENT_PROVIDER: provider,
      PAYMENTS_LIVE_ENABLED: live,
      ...credentials,
    });
    assert.equal(found.length === 0, ok, JSON.stringify(found));
  });
}

const production = {
  DEPLOYMENT_MODE: 'production',
  NODE_ENV: 'production',
  PAYMENT_PROVIDER: 'bachs-live',
};

test('PAYMENTS_LIVE_ENABLED is a real true or false', () => {
  const parsed = schema(true).parse({ ...production, ...liveCredentials });
  assert.equal(parsed.PAYMENTS_LIVE_ENABLED, false);
  assert.equal(
    schema(true).parse({
      ...production,
      ...liveCredentials,
      PAYMENTS_LIVE_ENABLED: 'true',
    }).PAYMENTS_LIVE_ENABLED,
    true,
  );
  assert.deepEqual(
    paths({ ...production, ...liveCredentials, PAYMENTS_LIVE_ENABLED: 'yes' }),
    ['PAYMENTS_LIVE_ENABLED'],
  );
});

test('bachs-live needs its live key and webhook secret', () => {
  assert.deepEqual(paths({ ...production, ...liveCredentials }), []);
  assert.deepEqual(
    paths({ ...production, BACHS_LIVE_WEBHOOK_SECRET: LIVE_SECRET }),
    ['BACHS_LIVE_API_KEY'],
  );
  assert.deepEqual(paths({ ...production, BACHS_LIVE_API_KEY: LIVE_KEY }), [
    'BACHS_LIVE_WEBHOOK_SECRET',
  ]);
  // The worker only asks Bachs for statuses, so it needs the key alone.
  assert.deepEqual(
    paths({ ...production, BACHS_LIVE_API_KEY: LIVE_KEY }, false),
    [],
  );
  assert.deepEqual(paths({ ...production }, false), ['BACHS_LIVE_API_KEY']);
});

test('a sandbox key in BACHS_LIVE_API_KEY, or a live key in BACHS_SANDBOX_API_KEY, is refused', () => {
  assert.deepEqual(
    paths({
      ...production,
      ...liveCredentials,
      BACHS_LIVE_API_KEY: 'sk_sandbox_dummy',
    }),
    ['BACHS_LIVE_API_KEY'],
  );
  assert.deepEqual(
    paths({
      DEPLOYMENT_MODE: 'preview',
      NODE_ENV: 'production',
      PAYMENT_PROVIDER: 'bachs-sandbox',
      ...sandboxCredentials,
      BACHS_SANDBOX_API_KEY: LIVE_KEY,
    }),
    ['BACHS_SANDBOX_API_KEY'],
  );
});

test('sandbox credentials are refused on a production copy even beside bachs-live', () => {
  for (const extra of [
    { BACHS_SANDBOX_API_KEY: 'sk_sandbox_dummy' },
    { BACHS_WEBHOOK_SECRET: 'b'.repeat(32) },
    { BACHS_PREVIOUS_WEBHOOK_SECRET: 'b'.repeat(32) },
  ]) {
    const found = issues({ ...production, ...liveCredentials, ...extra });
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].path[0], 'BACHS_SANDBOX_API_KEY');
  }
});

test('live credentials are refused on a copy that is not production', () => {
  for (const env of [
    { DEPLOYMENT_MODE: 'preview', NODE_ENV: 'production' },
    { DEPLOYMENT_MODE: 'production', NODE_ENV: 'test' },
  ]) {
    for (const extra of [
      { BACHS_LIVE_API_KEY: LIVE_KEY },
      { BACHS_LIVE_WEBHOOK_SECRET: LIVE_SECRET },
      { BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET: LIVE_SECRET },
    ]) {
      assert.deepEqual(paths({ ...env, PAYMENT_PROVIDER: 'mock', ...extra }), [
        'BACHS_LIVE_API_KEY',
      ]);
    }
  }
});

test('turning payments on needs bachs-live, and messages never show values', () => {
  const found = issues({
    DEPLOYMENT_MODE: 'preview',
    NODE_ENV: 'production',
    PAYMENT_PROVIDER: 'bachs-sandbox',
    PAYMENTS_LIVE_ENABLED: 'true',
    ...sandboxCredentials,
  });
  assert.deepEqual(
    found.map((issue) => issue.path.join('.')),
    ['PAYMENTS_LIVE_ENABLED'],
  );
  const all = JSON.stringify(
    issues({ ...production, ...sandboxCredentials, ...liveCredentials }),
  );
  for (const secret of ['sk_sandbox_dummy', LIVE_KEY, LIVE_SECRET])
    assert.equal(all.includes(secret), false);
});

test('bachs-live and a live key only name the live Bachs', () => {
  assert.equal(isLiveProvider('bachs-live'), true);
  assert.equal(isLiveProvider('bachs-sandbox'), false);
  assert.equal(bachsEnvironment('bachs-live'), 'live');
  assert.equal(bachsEnvironment('bachs-sandbox'), 'sandbox');
  assert.equal(bachsEnvironment('mock'), null);
});

test('every provider name is wired, and an unknown one fails closed', async () => {
  const { wiredPaymentProvider } = await import('../dist/index.js');
  assert.equal(wiredPaymentProvider('mock'), 'mock');
  assert.equal(wiredPaymentProvider('bachs-sandbox'), 'bachs-sandbox');
  assert.equal(wiredPaymentProvider('bachs-live'), 'bachs-live');
  assert.throws(
    () => wiredPaymentProvider('bachs'),
    /PAYMENT_PROVIDER=bachs is not wired/,
  );
});

test('both Bachs environments record their rows as provider bachs', async () => {
  const { recordedProviderName } = await import('../dist/index.js');
  assert.equal(recordedProviderName('bachs-live'), 'bachs');
  assert.equal(recordedProviderName('bachs-sandbox'), 'bachs');
  assert.equal(recordedProviderName('mock'), 'mock');
});
