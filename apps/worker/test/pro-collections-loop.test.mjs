import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBackProCollections } from '../dist/job-worker.js';

// Per-provider balances, Task 7 fix round 1: Pro paid from the balance can go through any provider
// in either role, so its read-back runs for every adapter the worker holds, under each one's own
// recorded name. Not only for those that also sell Pro by card (`initializePlatformCheckout`).

test('the balance read-back runs for every adapter, card checkout or not', async () => {
  const providers = [
    ['mock', { name: 'mock', initializePlatformCheckout: async () => ({}) }],
    // A withdraw-only adapter that sells no Pro by card still has balance payments to read back.
    ['mock_alt', { name: 'mock_alt' }],
    ['bachs', { name: 'bachs-sandbox' }],
  ];
  const asked = [];
  const totals = await readBackProCollections(
    providers,
    async (name, adapter) => {
      asked.push([name, adapter.name]);
      return {
        checked: 1,
        failed: name === 'bachs' ? 1 : 0,
        paid:
          name === 'mock_alt'
            ? [{ profileId: 'p', handleLower: 'ada', planChanged: true }]
            : [],
      };
    },
  );
  assert.deepEqual(asked, [
    ['mock', 'mock'],
    ['mock_alt', 'mock_alt'],
    ['bachs', 'bachs-sandbox'],
  ]);
  assert.equal(totals.checked, 3);
  assert.equal(totals.failed, 1);
  assert.deepEqual(totals.paid, [
    { profileId: 'p', handleLower: 'ada', planChanged: true },
  ]);
});
