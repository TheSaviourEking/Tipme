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

test('the registered switches, page_studio and refund_fee_return included for their open PRs, and the train’s', () => {
  assert.deepEqual([...FEATURE_SWITCHES].sort(), [
    'adult_platform_links',
    'analytics',
    'business',
    'business_owners',
    'business_pro',
    'business_shares',
    'business_signup',
    'campaign_pages',
    'page_studio',
    'pro_auto_renew',
    'pro_billing',
    'pro_pay_from_balance',
    'pro_refunds',
    'refund_fee_return',
    'supporter_recognition',
    'team_tips',
    'tip_refunds',
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
    'tip_refunds',
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

// Display settings (owner, 14 Nov 2026, #216): the pilot notice and the launch time, set in admin
// instead of the web app's Vercel settings. Non-money: a reason and a fresh code.
test('the display settings are the pilot notice and the launch time, each naming its old setting', async () => {
  const { DISPLAY_SETTINGS, DISPLAY_SETTING_CATALOGUE } =
    await import('../dist/index.js');
  assert.deepEqual(
    [...DISPLAY_SETTINGS],
    ['pilot_notice', 'production_launch_at', 'announcement_daily_limit'],
  );
  assert.equal(DISPLAY_SETTING_CATALOGUE.pilot_notice.envName, 'PILOT_NOTICE');
  assert.equal(
    DISPLAY_SETTING_CATALOGUE.production_launch_at.envName,
    'PRODUCTION_LAUNCH_AT',
  );
  for (const key of ['pilot_notice', 'production_launch_at'])
    assert.equal(DISPLAY_SETTING_CATALOGUE[key].group, 'web');
});

// The announcements daily limit (owner, 15 Nov 2026) is kept with the display settings, in its own
// "Limits" group: a whole number from 1 to 100,000, 300 while unset. It replaced no variable.
test('the announcements daily limit is a whole number from 1 to 100,000, 300 while unset', async () => {
  const {
    ANNOUNCEMENT_DAILY_LIMIT,
    DISPLAY_SETTING_CATALOGUE,
    announcementDailyLimitOf,
    checkedDisplayValue,
  } = await import('../dist/index.js');
  const entry = DISPLAY_SETTING_CATALOGUE.announcement_daily_limit;
  assert.equal(entry.kind, 'count');
  assert.equal(entry.group, 'limits');
  assert.equal(entry.envName, null);
  assert.deepEqual(ANNOUNCEMENT_DAILY_LIMIT, {
    default: 300,
    min: 1,
    max: 100_000,
  });
  assert.equal(checkedDisplayValue('announcement_daily_limit', '1'), '1');
  assert.equal(
    checkedDisplayValue('announcement_daily_limit', '100000'),
    '100000',
  );
  assert.equal(checkedDisplayValue('announcement_daily_limit', '0300'), '300');
  for (const bad of [null, '0', '100001', '-1', '2.5', '1e3', ' 5', 'many'])
    assert.throws(
      () => checkedDisplayValue('announcement_daily_limit', bad),
      String(bad),
    );
  assert.equal(announcementDailyLimitOf(undefined), 300);
  assert.equal(announcementDailyLimitOf(null), 300);
  assert.equal(announcementDailyLimitOf('nonsense'), 300);
  assert.equal(announcementDailyLimitOf('0'), 300);
  assert.equal(announcementDailyLimitOf('1200'), 1200);
});

test('a display value is checked: on or off for the notice; an exact instant, or none, for the launch', async () => {
  const { checkedDisplayValue, opsDisplaySettingSetSchema } =
    await import('../dist/index.js');
  assert.equal(checkedDisplayValue('pilot_notice', 'on'), 'on');
  assert.equal(checkedDisplayValue('pilot_notice', 'off'), 'off');
  assert.throws(() => checkedDisplayValue('pilot_notice', null));
  assert.throws(() => checkedDisplayValue('pilot_notice', 'true'));
  // Stored as UTC, whatever offset was given; none means open now.
  assert.equal(
    checkedDisplayValue('production_launch_at', '2026-10-27T00:00:00+01:00'),
    '2026-10-26T23:00:00.000Z',
  );
  assert.equal(checkedDisplayValue('production_launch_at', null), null);
  for (const bad of [
    '',
    '2026-10-27T00:00:00',
    'tomorrow',
    '2026-02-30T00:00:00Z',
  ])
    assert.throws(() => checkedDisplayValue('production_launch_at', bad));
  assert.throws(() => checkedDisplayValue('nope', 'on'));
  assert.equal(
    opsDisplaySettingSetSchema.safeParse({
      value: null,
      reason: 'Opening the site now',
    }).success,
    true,
  );
  assert.equal(
    opsDisplaySettingSetSchema.safeParse({ value: 'on', reason: 'short' })
      .success,
    false,
  );
});

test('the launch parser moved here and refuses anything but an exact instant, naming the old setting', async () => {
  const { parseProductionLaunchAt } = await import('../dist/index.js');
  assert.equal(parseProductionLaunchAt(undefined), null);
  assert.equal(
    parseProductionLaunchAt('2026-10-26T23:00:00Z'),
    Date.parse('2026-10-26T23:00:00Z'),
  );
  assert.throws(
    () => parseProductionLaunchAt('2026-10-27T00:00:00'),
    /PRODUCTION_LAUNCH_AT/,
  );
});

// Train 2 (owner, 14 Nov 2026: fewer environment variables): Business Pro's variable became a switch.
test('business_pro is a non-money switch, off by default, seeded from BUSINESS_PRO_ENABLED', () => {
  const entry = FEATURE_SWITCH_CATALOGUE.business_pro;
  assert.equal(entry.money, false);
  assert.equal(entry.default, false);
  assert.equal(entry.env.name, 'BUSINESS_PRO_ENABLED');
  assert.equal(
    featureSwitchFromEnv('business_pro', { BUSINESS_PRO_ENABLED: 'true' }),
    true,
  );
});

test('business_signup and business_owners are non-money switches, off by default, seeded from their variables', () => {
  for (const [key, name] of [
    ['business_signup', 'BUSINESS_SIGNUP_ENABLED'],
    ['business_owners', 'BUSINESS_OWNERS_ENABLED'],
  ]) {
    const entry = FEATURE_SWITCH_CATALOGUE[key];
    assert.equal(entry.money, false, key);
    assert.equal(entry.default, false, key);
    assert.equal(entry.env.name, name);
  }
});

test('campaign_pages is a non-money switch, off by default, seeded from CAMPAIGN_PAGES_ENABLED (#220)', () => {
  const entry = FEATURE_SWITCH_CATALOGUE.campaign_pages;
  assert.equal(entry.money, false);
  assert.equal(entry.default, false);
  assert.equal(entry.env.name, 'CAMPAIGN_PAGES_ENABLED');
});

// Owner, 14 Nov 2026: the switch only records a final refund at once (instead of two staff). A
// chargeback always returns TipMe's fee, with no switch, so the words never mention one or a fee.
// Staff read these words.
test('refund_fee_return says only what it does: final refunds recorded without two staff', () => {
  const entry = FEATURE_SWITCH_CATALOGUE.refund_fee_return;
  assert.equal(entry.money, true);
  assert.equal(entry.default, false);
  assert.equal(entry.env.name, 'REFUND_FEE_RETURN');
  assert.equal(entry.label, 'Record final refunds at once');
  assert.match(entry.description, /without two staff/);
  assert.doesNotMatch(entry.description, /chargeback|dispute|fee/i);
});

// #221 (owner, 14 Nov 2026: fewer variables): staff tip refunds move money, so a money switch.
test('tip_refunds is a money switch, off by default, seeded from TIP_REFUNDS (on/off)', () => {
  const entry = FEATURE_SWITCH_CATALOGUE.tip_refunds;
  assert.equal(entry.money, true);
  assert.equal(entry.default, false);
  assert.equal(entry.env.name, 'TIP_REFUNDS');
  assert.equal(
    featureSwitchFromEnv('tip_refunds', { TIP_REFUNDS: 'on' }),
    true,
  );
  assert.match(entry.description, /minus TipMe’s fee/);
});
