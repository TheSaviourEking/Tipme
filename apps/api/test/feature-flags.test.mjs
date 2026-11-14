import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeatureFlags } from '../dist/feature-flags.js';
import { loadApiConfig } from '../dist/config.js';

// #220's stand-in became the campaign_pages admin switch (#216) in merge train 2: `isOn` is
// `featureOn(db, key)`, so the call sites did not change.
const fakeDb = (rows) => ({
  select: () => ({ from: async () => rows }),
});

test('isOn reads the campaign_pages switch from the database, off when it has no row', async () => {
  const { resetFeatureSwitchMemory } = await import('@tipme/database');
  resetFeatureSwitchMemory();
  const off = new FeatureFlags({ db: fakeDb([]) });
  assert.equal(await off.isOn('campaign_pages'), false);
  const on = new FeatureFlags({
    db: fakeDb([{ key: 'campaign_pages', enabled: true }]),
  });
  assert.equal(await on.isOn('campaign_pages'), true);
});

test('it is not a deploy setting: the API config never carries it, only as a first-start seed', () => {
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
  assert.deepEqual(config.switchSeeds, { CAMPAIGN_PAGES_ENABLED: 'true' });
});
