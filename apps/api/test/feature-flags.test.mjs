import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeatureFlags } from '../dist/feature-flags.js';

// The thin stand-in for the admin switch system (PR #216): one async read per key, so the call
// sites stay the same when `isOn` becomes `featureOn(db, key)`.
test('isOn reads campaign_pages from CAMPAIGN_PAGES_ENABLED', async () => {
  assert.equal(
    await new FeatureFlags({ CAMPAIGN_PAGES_ENABLED: false }).isOn(
      'campaign_pages',
    ),
    false,
  );
  assert.equal(
    await new FeatureFlags({ CAMPAIGN_PAGES_ENABLED: true }).isOn(
      'campaign_pages',
    ),
    true,
  );
});
