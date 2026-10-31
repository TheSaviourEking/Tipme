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
