import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEDULED_RUN_RETENTION } from '../dist/ensure-schedule.js';
import {
  ensureSplitCheckSchedule,
  runProviderSplitCheck,
  SPLIT_CHECK_JOB,
  SPLIT_CHECK_READ_BUDGET,
} from '../dist/handlers/provider-split.js';

// Per-provider balances, Task 10 (spec §7, P12): the daily split check. No database and no Redis:
// the database operations and the lock are fakes, so this runs in the unit job.

/** The two Redis commands the lock uses, in memory. */
function fakeLock() {
  const values = new Map();
  return {
    values,
    async set(key, value) {
      if (values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async eval(_script, _count, key, token) {
      if (values.get(key) === token) values.delete(key);
      return 1;
    },
  };
}

/** A provider that counts every call made to it. */
const counted = (name, log) => ({
  name,
  capabilities: { connectedAccounts: false },
  async payoutCapability() {
    log.push(name);
    return { status: 'active', requirementsDue: [] };
  },
  async payoutBalance() {
    log.push(name);
    return { availableMinor: 0n };
  },
  async quotePayoutFee() {
    log.push(name);
    return { feeMinor: 0n, exact: false };
  },
});

test('the split check runs one owner at a time, stops at the read budget, and keeps run retention', async () => {
  const reads = [];
  const providers = {
    active: counted('mock', reads),
    withdrawOnly: [counted('mock_alt', reads), counted('other', reads)],
  };
  const due = Array.from({ length: 20 }, (_, i) => ({
    profileId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  }));
  const calls = { due: [], checked: [], flagged: 0, purged: 0 };
  let running = 0;
  let mostAtOnce = 0;
  const ops = {
    async splitOwnersDue(_db, set, input) {
      calls.due.push(input);
      assert.equal(set.withdrawOnly.length, 2);
      return due;
    },
    async checkProviderSplit(_db, owner, set, input) {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      calls.checked.push(owner);
      assert.ok(input.now instanceof Date);
      // Every provider in the set is read once, through the set the handler passed in.
      for (const provider of [...set.withdrawOnly, set.active])
        await provider.payoutBalance('ref', 'NGN');
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return { outcome: 'ok' };
    },
    async flagUnconnectedMoney() {
      calls.flagged += 1;
      return 1;
    },
    async purgeSplitChecks() {
      calls.purged += 1;
      return 3;
    },
  };
  const now = new Date('2026-11-24T09:00:00Z');
  const lock = fakeLock();
  const result = await runProviderSplitCheck(lock, 'tipme-test:lock', {
    db: {},
    providers,
    now,
    ops,
  });
  assert.equal(result.ran, true);
  // One owner at a time.
  assert.equal(mostAtOnce, 1);
  assert.deepEqual(calls.due, [{ now, limit: 20 }]);
  // Three providers, and a short owner is read twice: up to 6 reads an owner. These read 3 each,
  // so 12 owners make 36, and a 13th could pass 40: the run stops there.
  assert.equal(SPLIT_CHECK_READ_BUDGET, 40);
  assert.equal(calls.checked.length, 12);
  assert.deepEqual(calls.checked, due.slice(0, 12));
  assert.equal(reads.length, 36);
  assert.deepEqual(result.value, {
    checked: 12,
    ok: 12,
    short: 0,
    over: 0,
    partial: 0,
    failed: 0,
    reads: 36,
    stoppedEarly: true,
    unconnected: 1,
    purged: 3,
  });
  assert.equal(calls.flagged, 1);
  assert.equal(calls.purged, 1);
  // The lock is free again for the next run.
  assert.equal(lock.values.has('tipme-test:lock'), false);

  // The next run checks owners again, but the unconnected sweep and the purge are daily.
  const again = await runProviderSplitCheck(lock, 'tipme-test:lock', {
    db: {},
    providers,
    now,
    ops,
  });
  assert.equal(again.ran, true);
  assert.equal(again.value.checked, 12);
  assert.equal(again.value.unconnected, null);
  assert.equal(again.value.purged, null);
  assert.equal(calls.flagged, 1);
  assert.equal(calls.purged, 1);
  const checkedSoFar = calls.checked.length;

  // A run still going makes the next one skip: nothing is read or checked.
  lock.values.set('tipme-test:lock', 'someone-else');
  const skipped = await runProviderSplitCheck(lock, 'tipme-test:lock', {
    db: {},
    providers,
    now,
    ops,
  });
  assert.deepEqual(skipped, { ran: false });
  assert.equal(calls.checked.length, checkedSoFar);

  // Every 15 minutes, and the 21 Nov rule: finished runs never stay in Redis.
  const upserts = [];
  const queue = {
    upsertJobScheduler: async (id, repeat, template) => {
      upserts.push({ id, repeat, template });
    },
  };
  const schedule = ensureSplitCheckSchedule({
    queue,
    logger: { warn: () => undefined },
  });
  await schedule.ready;
  assert.equal(SPLIT_CHECK_JOB, 'payments.split_check');
  assert.deepEqual(upserts, [
    {
      id: 'payments.split_check',
      repeat: { every: 15 * 60_000 },
      template: { name: 'payments.split_check', opts: SCHEDULED_RUN_RETENTION },
    },
  ]);
  assert.deepEqual(SCHEDULED_RUN_RETENTION, {
    removeOnComplete: true,
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  await schedule.stop();
});

test('with no withdraw-only provider nothing is due and nothing is read', async () => {
  const reads = [];
  const providers = { active: counted('mock', reads), withdrawOnly: [] };
  const result = await runProviderSplitCheck(fakeLock(), 'k', {
    db: {},
    providers,
    now: new Date(),
    ops: {
      splitOwnersDue: async () => [],
      checkProviderSplit: async () => {
        throw new Error('not called');
      },
      flagUnconnectedMoney: async () => 0,
      purgeSplitChecks: async () => 0,
    },
  });
  assert.equal(result.ran, true);
  assert.equal(result.value.checked, 0);
  assert.equal(result.value.stoppedEarly, false);
  assert.deepEqual(reads, []);
});

test('one owner that always fails is logged by id and never stops the others, the sweep or the purge', async () => {
  const reads = [];
  const providers = {
    active: counted('mock', reads),
    withdrawOnly: [counted('mock_alt', reads)],
  };
  const bad = { profileId: '00000000-0000-4000-8000-000000000bad' };
  const good = [
    { profileId: '00000000-0000-4000-8000-000000000001' },
    { businessId: '00000000-0000-4000-8000-000000000002' },
  ];
  const checked = [];
  const entries = [];
  let flagged = 0;
  let purged = 0;
  const result = await runProviderSplitCheck(fakeLock(), 'k', {
    db: {},
    providers,
    now: new Date(),
    log: (entry) => entries.push(entry),
    ops: {
      splitOwnersDue: async () => [good[0], bad, good[1]],
      async checkProviderSplit(_db, owner) {
        if (owner === bad)
          throw new Error(
            'broken row for 00000000-0000-4000-8000-000000000bad',
          );
        checked.push(owner);
        return { outcome: 'short' };
      },
      flagUnconnectedMoney: async () => {
        flagged += 1;
        return 0;
      },
      purgeSplitChecks: async () => {
        purged += 1;
        return 0;
      },
    },
  });
  assert.equal(result.ran, true);
  assert.deepEqual(checked, good);
  assert.equal(result.value.checked, 2);
  assert.equal(result.value.short, 2);
  assert.equal(result.value.failed, 1);
  assert.equal(flagged, 1);
  assert.equal(purged, 1);
  // The owner's id only: never the error's text, which could carry anything.
  assert.deepEqual(entries, [
    { event: 'split_check.owner_failed', owner: bad.profileId },
  ]);
});
