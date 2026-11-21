import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCollectReminders } from '../dist/handlers/collect-reminders.js';

// You collect (plan Task 12): the transfer sweep also reminds recipients with tips waiting for bank
// details. The reminders themselves are proven against Postgres in tests/integration/collect-guards.

const NOW = new Date('2026-11-20T10:00:00.000Z');
const db = Symbol('db');
const sealing = Symbol('sealing');

test('a pass sends with the sweep’s clock and sealing, and counts what it sent', async () => {
  const outcome = await handleCollectReminders({
    db,
    sealing,
    now: NOW,
    log: () => assert.fail('nothing to log'),
    remind: async (database, input) => {
      assert.equal(database, db);
      assert.deepEqual(input, { now: NOW, sealing });
      return 2;
    },
  });
  assert.deepEqual(outcome, { reminded: 2, failed: 0 });
});

test('a failure is logged by its name only and never thrown', async () => {
  const logs = [];
  const outcome = await handleCollectReminders({
    db,
    sealing,
    now: NOW,
    log: (entry) => logs.push(entry),
    remind: async () => {
      throw new TypeError('acct_secret in a message');
    },
  });
  assert.deepEqual(outcome, { reminded: 0, failed: 1 });
  assert.deepEqual(logs, [
    { event: 'collect_reminders.failed', error: 'TypeError' },
  ]);
});
