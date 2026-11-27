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

// Live updates (addendum §3.7): the read-backs' settled purchases sum across adapters, and each
// one with a page becomes one pro.changed; a business's purchase has no page (ruling L-R15).
test('the balance read-back sums settled purchases across adapters', async () => {
  const totals = await readBackProCollections(
    [
      ['mock', {}],
      ['bachs', {}],
    ],
    async (name) => ({
      checked: 1,
      failed: 0,
      paid: [],
      settled: name === 'bachs' ? [{ profileId: 'p2' }] : [{ profileId: 'p1' }],
    }),
  );
  assert.deepEqual(totals.settled, [{ profileId: 'p1' }, { profileId: 'p2' }]);
});

test('each settled purchase with a page is one pro.changed to that page; none for a business', async () => {
  const { proSettledSignals } = await import('../dist/job-worker.js');
  const PAGE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  assert.deepEqual(
    proSettledSignals([{ profileId: PAGE }, { profileId: null }]),
    [{ to: { profile: PAGE }, type: 'pro.changed' }],
  );
  assert.deepEqual(proSettledSignals([]), []);
});
