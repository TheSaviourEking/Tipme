import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SCHEDULED_RUN_RETENTION } from '../dist/ensure-schedule.js';
import {
  ensureFeeWaiversSchedule,
  FEE_WAIVERS_JOB,
  FEE_WAIVERS_PAUSED_ALERT,
  handleFeeWaivers,
} from '../dist/handlers/fee-waivers.js';

// Fee waivers, plan Task 8 (W13, W14): the `fees.waivers` job around runFeeWaiverNotices
// (packages/database/test/integration/fee-waiver-notices.test.mjs covers the notices themselves).
// No database: the run is a fake that answers each turn in order.

const result = (paused) => ({ endingSoon: 0, started: 0, ended: 0, paused });

test('the alert is posted once per spell and the job keeps run retention', async () => {
  const turns = [
    'none',
    'opened',
    'open',
    'open',
    'resolved',
    'none',
    'opened',
  ];
  const posted = [];
  const calls = [];
  const now = new Date('2026-11-26T09:00:00Z');
  for (const paused of turns) {
    const outcome = await handleFeeWaivers({
      db: {},
      activeProvider: 'bachs-sandbox',
      alert: async (text) => posted.push(text),
      now,
      run: async (db, input) => {
        calls.push(input);
        return result(paused);
      },
    });
    assert.equal(outcome.paused, paused);
  }
  // Two spells, two alerts, in the spec's words.
  assert.equal(
    FEE_WAIVERS_PAUSED_ALERT,
    "Fee waivers paused: TipMe's balance is low",
  );
  assert.deepEqual(posted, [
    FEE_WAIVERS_PAUSED_ALERT,
    FEE_WAIVERS_PAUSED_ALERT,
  ]);
  // The active provider and the clock reach the run as given.
  assert.deepEqual(calls[0], { activeProvider: 'bachs-sandbox', now });

  // This job's own schedule: every 15 minutes, with the 21 Nov rule's template options.
  const upserts = [];
  const queue = {
    upsertJobScheduler: async (id, repeat, template) => {
      upserts.push({ id, repeat, template });
    },
  };
  const schedule = ensureFeeWaiversSchedule({
    queue,
    logger: { warn: () => undefined },
  });
  await schedule.ready;
  assert.equal(FEE_WAIVERS_JOB, 'fees.waivers');
  assert.deepEqual(upserts, [
    {
      id: 'fees.waivers',
      repeat: { every: 15 * 60_000 },
      template: { name: 'fees.waivers', opts: SCHEDULED_RUN_RETENTION },
    },
  ]);
  assert.deepEqual(upserts[0].template.opts, {
    removeOnComplete: true,
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  await schedule.stop();

  // And the worker schedules it with that helper, runs it behind the run lock, and stops it.
  const source = readFileSync(
    new URL('../src/job-worker.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /const feeWaiversSchedule = ensureFeeWaiversSchedule\(\{ queue, logger \}\)/,
  );
  assert.match(
    source,
    /job\.name === FEE_WAIVERS_JOB\) \{\s+const result = await runUnlessRunning\(/,
  );
  assert.match(source, /feeWaiversSchedule\.stop\(\)/);
});

test('an alert that cannot be posted is logged, never thrown: the issue is already open', async () => {
  const logs = [];
  const outcome = await handleFeeWaivers({
    db: {},
    activeProvider: 'mock',
    alert: async () => {
      throw new Error('alert_route_missing');
    },
    now: new Date(),
    log: (entry) => logs.push(entry),
    run: async () => result('opened'),
  });
  assert.equal(outcome.paused, 'opened');
  assert.deepEqual(logs, [
    { event: 'fee_waivers.alert_failed', error: 'alert_route_missing' },
  ]);
});
