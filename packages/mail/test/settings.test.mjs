import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  checkMailSettings,
  configuredMailProviders,
  mailSettingsShape,
} from '../dist/index.js';

// One definition of the mail settings for the API and the worker: a provider is configured only
// when all its keys are present; half a configuration is an error that names the missing key.

const schema = z
  .object({ NODE_ENV: z.string().default('test'), ...mailSettingsShape })
  .superRefine((config, context) => checkMailSettings(config, context));
const parse = (env) => schema.safeParse(env);
const missing = (result) =>
  result.success ? [] : result.error.issues.map((i) => i.path.join('.'));

const ZEPTO = {
  ZEPTOMAIL_API_KEY: 'zepto-secret-key-value',
  ZEPTOMAIL_API_BASE: 'https://api.zeptomail.com',
  ZEPTOMAIL_WEBHOOK_KEY: 'zepto-webhook-secret-value',
};
const SES = {
  SES_CONFIGURATION_SET: 'tipme-staging-tracked',
  SES_CONFIGURATION_SET_UNTRACKED: 'tipme-staging-untracked',
  SES_SNS_TOPIC_ARN:
    'arn:aws:sns:eu-north-1:185678361212:tipme-staging-mail-events',
};

test('a partial ZeptoMail configuration fails startup naming the missing key', () => {
  const result = parse({
    ZEPTOMAIL_API_KEY: ZEPTO.ZEPTOMAIL_API_KEY,
    ZEPTOMAIL_API_BASE: ZEPTO.ZEPTOMAIL_API_BASE,
  });
  assert.deepEqual(missing(result), ['ZEPTOMAIL_WEBHOOK_KEY']);
});

test('SES is configured only with all its keys', () => {
  assert.deepEqual(missing(parse({ SES_CONFIGURATION_SET: 'x' })).sort(), [
    'SES_CONFIGURATION_SET_UNTRACKED',
    'SES_SNS_TOPIC_ARN',
  ]);
  assert.deepEqual(
    missing(parse({ ...SES, SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' })),
    ['SES_SECRET_ACCESS_KEY'],
  );
  const config = parse({ ...SES }).data;
  assert.equal(config.SES_REGION, 'eu-north-1');
  assert.deepEqual(
    [...configuredMailProviders(config, async () => {}).keys()].sort(),
    ['mock', 'ses'],
  );
});

test('the default provider must be configured', () => {
  assert.deepEqual(missing(parse({ MAIL_DEFAULT_PROVIDER: 'zeptomail' })), [
    'MAIL_DEFAULT_PROVIDER',
  ]);
  assert.equal(
    parse({ MAIL_DEFAULT_PROVIDER: 'zeptomail', ...ZEPTO }).success,
    true,
  );
});

test('secrets never appear in config errors', () => {
  const result = parse({
    ZEPTOMAIL_API_KEY: ZEPTO.ZEPTOMAIL_API_KEY,
    SES_ACCESS_KEY_ID: 'AKIASECRETVALUE',
  });
  const text = JSON.stringify(result.error.issues);
  assert.ok(!text.includes('zepto-secret-key-value'));
  assert.ok(!text.includes('AKIASECRETVALUE'));
});

test('the pretend provider exists only outside production', () => {
  const dev = parse({ ...ZEPTO }).data;
  assert.deepEqual(
    [...configuredMailProviders(dev, async () => {}).keys()].sort(),
    ['mock', 'zeptomail'],
  );
  const live = configuredMailProviders(
    { ...dev, NODE_ENV: 'production', DEPLOYMENT_MODE: 'production' },
    async () => {},
  );
  assert.deepEqual([...live.keys()], ['zeptomail']);
});

test('a person’s override wins, unless that provider is not configured', async () => {
  const { resolveMailProvider } = await import('../dist/index.js');
  const configured = new Set(['zeptomail', 'ses']);
  const route = (override, pinned = null) =>
    resolveMailProvider({ pinned, override, active: 'zeptomail', configured });
  assert.equal(route(null), 'zeptomail');
  assert.equal(route('ses'), 'ses');
  assert.equal(route('mock'), 'zeptomail');
  assert.equal(route('ses', 'mock'), 'mock', 'a test stays on its provider');
});

// Automatic failover (owner, 23 Nov 2026): an ordered fallback list, empty by default so nothing
// changes until it is set, with the approved defaults for both signals. The pretend provider is
// never a fallback in production, and a fallback must be configured.

const BREVO_CODES = {
  BREVO_API_KEY: 'brevo-secret-key-value',
  BREVO_WEBHOOK_TOKEN: 'brevo-webhook-token-value',
  BREVO_TRANSACTIONAL: 'on',
};
const LIVE = { NODE_ENV: 'production', DEPLOYMENT_MODE: 'production' };

test('no fallback by default, and the failover settings have the approved defaults', () => {
  const config = parse({ ...ZEPTO, MAIL_DEFAULT_PROVIDER: 'zeptomail' }).data;
  assert.deepEqual(config.MAIL_FALLBACK_PROVIDERS, []);
  assert.equal(config.MAIL_BREAKER_FAILURES, 3);
  assert.equal(config.MAIL_BREAKER_WINDOW_MS, 300_000);
  assert.equal(config.MAIL_BREAKER_REST_MS, 900_000);
  assert.equal(config.MAIL_CODE_UNUSED_AFTER_MS, 180_000);
  assert.equal(config.MAIL_CODE_WINDOW_MS, 600_000);
  assert.equal(config.MAIL_CODE_MIN_SAMPLES, 5);
  assert.equal(config.MAIL_CODE_UNUSED_RATIO, 0.6);
  assert.equal(config.MAIL_CODE_TRIAL_CODES, 3);
  assert.equal(config.MAIL_RESEND_WINDOW_MS, 600_000);
});

test('the fallback list is read in order and names known, configured providers only', () => {
  const config = parse({
    ...ZEPTO,
    ...SES,
    ...BREVO_CODES,
    MAIL_DEFAULT_PROVIDER: 'zeptomail',
    MAIL_FALLBACK_PROVIDERS: ' brevo , ses ',
  }).data;
  assert.deepEqual(config.MAIL_FALLBACK_PROVIDERS, ['brevo', 'ses']);
  assert.deepEqual(
    missing(parse({ ...ZEPTO, MAIL_FALLBACK_PROVIDERS: 'postmark' })),
    ['MAIL_FALLBACK_PROVIDERS'],
  );
  // Brevo as a fallback needs BREVO_TRANSACTIONAL=on and its keys.
  assert.deepEqual(
    missing(
      parse({
        ...ZEPTO,
        MAIL_DEFAULT_PROVIDER: 'zeptomail',
        MAIL_FALLBACK_PROVIDERS: 'brevo',
      }),
    ),
    ['MAIL_FALLBACK_PROVIDERS'],
  );
});

test('production never lists the pretend provider as a fallback', () => {
  assert.deepEqual(
    missing(
      parse({
        ...ZEPTO,
        ...LIVE,
        MAIL_DEFAULT_PROVIDER: 'zeptomail',
        MAIL_FALLBACK_PROVIDERS: 'mock',
      }),
    ),
    ['MAIL_FALLBACK_PROVIDERS'],
  );
  // Elsewhere a developer may.
  assert.equal(
    parse({
      ...ZEPTO,
      MAIL_DEFAULT_PROVIDER: 'zeptomail',
      MAIL_FALLBACK_PROVIDERS: 'mock',
    }).success,
    true,
  );
});

test('the unused-code ratio is a fraction', () => {
  assert.deepEqual(missing(parse({ MAIL_CODE_UNUSED_RATIO: '1.5' })), [
    'MAIL_CODE_UNUSED_RATIO',
  ]);
  assert.equal(
    parse({ MAIL_CODE_UNUSED_RATIO: '0.75' }).data.MAIL_CODE_UNUSED_RATIO,
    0.75,
  );
});

test('a fallback list naming only the default provider is refused (no backup at all)', () => {
  assert.deepEqual(
    missing(
      parse({
        ...ZEPTO,
        MAIL_DEFAULT_PROVIDER: 'zeptomail',
        MAIL_FALLBACK_PROVIDERS: 'zeptomail',
      }),
    ),
    ['MAIL_FALLBACK_PROVIDERS'],
  );
});
