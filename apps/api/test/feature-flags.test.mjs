import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeatureFlags, proPageFeaturesFromEnv } from '../dist/feature-flags.js';
import { loadApiConfig } from '../dist/config.js';

// The stand-in for the admin switch system (PR #216): one async read per key, so the call sites
// stay the same when `isOn` becomes `featureOn(db, key)`.
test('campaign_pages defaults to off; true turns it on; anything else is refused', () => {
  assert.deepEqual(proPageFeaturesFromEnv({}), { campaign_pages: false });
  assert.deepEqual(proPageFeaturesFromEnv({ CAMPAIGN_PAGES_ENABLED: '' }), {
    campaign_pages: false,
  });
  assert.deepEqual(proPageFeaturesFromEnv({ CAMPAIGN_PAGES_ENABLED: 'true' }), {
    campaign_pages: true,
  });
  assert.throws(
    () => proPageFeaturesFromEnv({ CAMPAIGN_PAGES_ENABLED: 'yes' }),
    /CAMPAIGN_PAGES_ENABLED/,
  );
});

test('isOn reads the stand-in', async () => {
  assert.equal(
    await new FeatureFlags({ campaign_pages: false }).isOn('campaign_pages'),
    false,
  );
  assert.equal(
    await new FeatureFlags({ campaign_pages: true }).isOn('campaign_pages'),
    true,
  );
});

test('it is not a deploy setting: the API config never carries it', () => {
  const config = loadApiConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
    REDIS_URL: 'redis://127.0.0.1:6379',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
    STATUS_TOKEN_SECRET: 's'.repeat(32),
    AUTH_CODE_SECRET: 'a'.repeat(32),
    WEB_REVALIDATE_SECRET: 'r'.repeat(32),
    OPS_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'),
    MAIL_SEAL_KEY: Buffer.alloc(32, 2).toString('base64'),
    CAMPAIGN_PAGES_ENABLED: 'true',
  });
  assert.equal('CAMPAIGN_PAGES_ENABLED' in config, false);
});
