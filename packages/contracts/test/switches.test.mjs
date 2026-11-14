import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FEATURE_SWITCHES,
  FEATURE_SWITCH_CATALOGUE,
  OPS_CATALOGUE,
  OPS_PERMISSIONS,
  SERIOUS_ACTIONS,
  SERIOUS_ACTION_PERMISSIONS,
  SERIOUS_ACTION_WORDS,
  featureSwitchFromEnv,
  isFeatureSwitch,
  opsFeatureSwitchSetSchema,
} from '../dist/index.js';

// Owner, 14 Nov 2026: switches move from the environment to admin (docs/runbooks/settings-and-switches.md).

test('the registered switches, page_studio and refund_fee_return included for their open PRs', () => {
  assert.deepEqual([...FEATURE_SWITCHES].sort(), [
    'adult_platform_links',
    'analytics',
    'business',
    'business_shares',
    'page_studio',
    'pro_auto_renew',
    'pro_billing',
    'pro_pay_from_balance',
    'pro_refunds',
    'refund_fee_return',
    'supporter_recognition',
    'team_tips',
  ]);
  for (const key of FEATURE_SWITCHES) {
    const entry = FEATURE_SWITCH_CATALOGUE[key];
    assert.ok(entry.label.length > 2, key);
    assert.ok(entry.description.length > 10, key);
    assert.match(entry.env.name, /^[A-Z][A-Z0-9_]+$/);
  }
});

test('money switches are exactly the owner’s list (and team tips), and none defaults to on', () => {
  const money = FEATURE_SWITCHES.filter(
    (key) => FEATURE_SWITCH_CATALOGUE[key].money,
  ).sort();
  assert.deepEqual(money, [
    'business_shares',
    'pro_auto_renew',
    'pro_billing',
    'pro_pay_from_balance',
    'pro_refunds',
    'refund_fee_return',
    'team_tips',
  ]);
  for (const key of money)
    assert.equal(FEATURE_SWITCH_CATALOGUE[key].default, false, key);
});

test('defaults are today’s code defaults', () => {
  const on = FEATURE_SWITCHES.filter(
    (key) => FEATURE_SWITCH_CATALOGUE[key].default,
  ).sort();
  assert.deepEqual(on, [
    'adult_platform_links',
    'analytics',
    'supporter_recognition',
  ]);
});

test('an old variable is read in its own words; unset or blank is no value; anything else throws', () => {
  assert.equal(
    featureSwitchFromEnv('pro_billing', { PRO_BILLING_ENABLED: 'true' }),
    true,
  );
  assert.equal(
    featureSwitchFromEnv('pro_billing', { PRO_BILLING_ENABLED: 'false' }),
    false,
  );
  assert.equal(
    featureSwitchFromEnv('pro_refunds', { PRO_REFUNDS: 'on' }),
    true,
  );
  assert.equal(
    featureSwitchFromEnv('pro_refunds', { PRO_REFUNDS: 'off' }),
    false,
  );
  assert.equal(
    featureSwitchFromEnv('adult_platform_links', {
      ADULT_PLATFORM_LINKS: 'off',
    }),
    false,
  );
  assert.equal(
    featureSwitchFromEnv('page_studio', { PAGE_STUDIO_ENABLED: 'true' }),
    true,
  );
  assert.equal(featureSwitchFromEnv('pro_billing', {}), undefined);
  assert.equal(
    featureSwitchFromEnv('pro_billing', { PRO_BILLING_ENABLED: '' }),
    undefined,
  );
  assert.throws(
    () => featureSwitchFromEnv('pro_billing', { PRO_BILLING_ENABLED: 'on' }),
    /PRO_BILLING_ENABLED/,
  );
  assert.throws(
    () => featureSwitchFromEnv('pro_refunds', { PRO_REFUNDS: 'true' }),
    /PRO_REFUNDS/,
  );
});

test('isFeatureSwitch knows only registered keys', () => {
  assert.equal(isFeatureSwitch('page_studio'), true);
  assert.equal(isFeatureSwitch('toString'), false);
  assert.equal(isFeatureSwitch('PAGE_STUDIO_ENABLED'), false);
});

test('switches.manage is a sensitive settings permission; feature_switch.set maps to it', () => {
  assert.ok(OPS_PERMISSIONS.includes('switches.manage'));
  assert.equal(OPS_CATALOGUE['switches.manage'].sensitive, true);
  assert.equal(OPS_CATALOGUE['switches.manage'].group, 'settings');
  assert.ok(SERIOUS_ACTIONS.includes('feature_switch.set'));
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['feature_switch.set'],
    'switches.manage',
  );
  assert.match(SERIOUS_ACTION_WORDS['feature_switch.set'], /switch/i);
});

test('a change says on or off, with a reason of at least 10 characters', () => {
  assert.equal(
    opsFeatureSwitchSetSchema.safeParse({
      on: true,
      reason: 'Opening Pro to everyone',
    }).success,
    true,
  );
  assert.equal(
    opsFeatureSwitchSetSchema.safeParse({ on: true, reason: 'short' }).success,
    false,
  );
  assert.equal(
    opsFeatureSwitchSetSchema.safeParse({
      on: 'true',
      reason: 'Opening Pro to everyone',
    }).success,
    false,
  );
  assert.equal(
    opsFeatureSwitchSetSchema.safeParse({
      on: true,
      reason: 'Opening Pro to everyone',
      extra: 1,
    }).success,
    false,
  );
});
