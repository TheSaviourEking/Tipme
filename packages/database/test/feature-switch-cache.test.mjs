import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  featureOn,
  invalidateFeatureSwitches,
  resetFeatureSwitchMemory,
} from '../dist/index.js';

// A stand-in database whose reads wait until the test lets each one answer, so a read can be kept
// in flight across a change.
function slowDb() {
  const reads = [];
  const db = {
    select: () => ({
      from: () =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
    }),
  };
  return { db, reads };
}

// Merge train 2: under load, a read that started before a switch changed was handed to callers
// that asked after the change, so they saw the old value (account-api's celebrate, once).
test('a read that started before a change is not reused by a caller who asks after it', async () => {
  resetFeatureSwitchMemory();
  const { db, reads } = slowDb();
  const before = featureOn(db, 'campaign_pages');
  await Promise.resolve();
  assert.equal(reads.length, 1);
  // Staff turn it on (the row is written), and this process forgets what it read.
  invalidateFeatureSwitches();
  const after = featureOn(db, 'campaign_pages');
  await Promise.resolve();
  assert.equal(reads.length, 2, 'the later caller starts its own read');
  reads[0]([]);
  reads[1]([{ key: 'campaign_pages', enabled: true }]);
  assert.equal(await before, false);
  assert.equal(await after, true);
  // And the older read, answering last, never overwrites the newer one.
  assert.equal(await featureOn(db, 'campaign_pages'), true);
});

test('callers in the same generation still share one read', async () => {
  resetFeatureSwitchMemory();
  const { db, reads } = slowDb();
  const one = featureOn(db, 'campaign_pages');
  const two = featureOn(db, 'business_pro');
  await Promise.resolve();
  assert.equal(reads.length, 1);
  reads[0]([{ key: 'business_pro', enabled: true }]);
  assert.equal(await one, false);
  assert.equal(await two, true);
});
