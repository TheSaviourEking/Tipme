import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectReconReader,
  collectReserveReader,
  handleCollectRecon,
  handleCollectReserve,
} from '../dist/handlers/collect-reserve.js';

// You collect (plan Task 11): the worker's reserve check and daily reconciliation, with the database
// operations replaced, so nothing here reads a partner or a database.

const db = {};
const sealing = {};
const reader = { name: 'bachs-sandbox' };

test('a critical reserve alert is posted as paging, a warning as it is, and owners are mailed once a day per alert', async () => {
  const posts = [];
  const mailed = [];
  const purged = [];
  const fetchImpl = async (_url, init) => {
    posts.push(JSON.parse(init.body).text);
    return new Response('ok', { status: 200 });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const logs = [];
    const outcome = await handleCollectReserve({
      db,
      provider: reader,
      alertWebhookUrl: 'https://hooks.example.test/x',
      sealing,
      log: (entry) => logs.push(entry),
      now: new Date('2026-11-22T10:00:00Z'),
      purge: async (_db, input) => {
        purged.push(input.before);
        return 0;
      },
      mailOwners: async (_db, _sealing, input) => {
        mailed.push(input);
        return 1;
      },
      check: async (_db, i) => {
        await i.alert('low', 'warning');
        await i.alert('short', 'critical');
        await i.emailOwners('short');
        await i.emailOwners('short');
        return {
          perCurrency: [
            {
              currency: 'NGN',
              availableMinor: 1n,
              heldMinor: 2n,
              ownMinor: -1n,
              level: 'broken',
            },
          ],
          autoPayoutOn: false,
        };
      },
    });
    assert.equal(outcome, 'checked');
    assert.deepEqual(posts, ['low', 'CRITICAL: short']);
    // The same text the same Lagos day keys the same emails: queued once by their dedupe key.
    assert.equal(mailed.length, 2);
    assert.equal(mailed[0].spell, mailed[1].spell);
    // Old readings that said nothing was wrong are purged after the check (m9).
    assert.equal(purged.length, 1);
    assert.ok(purged[0] < new Date('2026-11-22T10:00:00Z'));
    assert.equal(logs.at(-1).event, 'collect_reserve.checked');
    assert.equal(logs.at(-1).levels, 'NGN:broken');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed reserve check is logged by name and never thrown', async () => {
  const logs = [];
  const outcome = await handleCollectReserve({
    db,
    provider: reader,
    alertWebhookUrl: undefined,
    sealing,
    log: (entry) => logs.push(entry),
    check: async () => {
      throw new TypeError('connection refused to secret-host');
    },
  });
  assert.equal(outcome, 'failed');
  assert.deepEqual(logs, [
    { event: 'collect_reserve.failed', error: 'TypeError' },
  ]);
});

test('the daily reconciliation logs its totals, and a failure is an outcome', async () => {
  const logs = [];
  const day = new Date('2026-11-22T01:00:00Z');
  assert.equal(
    await handleCollectRecon({
      db,
      provider: reader,
      log: (entry) => logs.push(entry),
      day,
      recon: async (_db, i) => {
        assert.equal(i.day, day);
        return { checked: 7, mismatches: 1, unreadable: 0 };
      },
    }),
    'reconciled',
  );
  assert.deepEqual(logs, [
    {
      event: 'collect_recon.completed',
      checked: 7,
      mismatches: 1,
      unreadable: 0,
    },
  ]);
  assert.equal(
    await handleCollectRecon({
      db,
      provider: reader,
      log: (entry) => logs.push(entry),
      recon: async () => {
        throw new Error('boom');
      },
    }),
    'failed',
  );
  assert.equal(logs.at(-1).event, 'collect_recon.failed');
});

test('a provider without the reads gets no reserve check or reconciliation', () => {
  assert.equal(collectReserveReader({ name: 'mock' }), null);
  assert.equal(collectReconReader({ name: 'mock' }), null);
  const full = {
    name: 'bachs-sandbox',
    async platformBalances() {
      return [];
    },
    async platformPayoutSchedule() {
      return {};
    },
    async listAccountTransfers() {
      return [];
    },
    async listDisputes() {
      return [];
    },
  };
  assert.equal(collectReserveReader(full).name, 'bachs-sandbox');
  assert.equal(collectReconReader(full).name, 'bachs-sandbox');
});
