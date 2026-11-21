import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureSchedule } from '../dist/ensure-schedule.js';

const logger = { warn: () => undefined, info: () => undefined };

test('a failed schedule registration is retried until it succeeds', async () => {
  let calls = 0;
  const queue = {
    upsertJobScheduler: async () => {
      calls += 1;
      if (calls < 3) throw new Error('redis down');
    },
  };
  const schedule = ensureSchedule({
    queue,
    id: 'reconcile.payments',
    every: 1000,
    logger,
    retryMs: 10,
  });
  await schedule.ready;
  assert.equal(calls, 3);
  await schedule.stop();
});

test('stopping gives up retrying', async () => {
  let calls = 0;
  const queue = {
    upsertJobScheduler: async () => {
      calls += 1;
      throw new Error('redis down');
    },
  };
  const schedule = ensureSchedule({
    queue,
    id: 'x',
    every: 1000,
    logger,
    retryMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  await schedule.stop();
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, after);
});

test('a schedule can be a cron pattern in a time zone', async () => {
  const calls = [];
  const queue = {
    upsertJobScheduler: async (id, repeat, template) => {
      calls.push({ id, repeat, template });
    },
  };
  const schedule = ensureSchedule({
    queue,
    id: 'reports.weekly',
    repeat: { pattern: '0 7 * * 1', tz: 'Africa/Lagos' },
    logger: { warn() {} },
  });
  await schedule.ready;
  assert.deepEqual(calls, [
    {
      id: 'reports.weekly',
      repeat: { pattern: '0 7 * * 1', tz: 'Africa/Lagos' },
      template: {
        name: 'reports.weekly',
        opts: {
          removeOnComplete: true,
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      },
    },
  ]);
  await schedule.stop();
});

test('a scheduled run is removed when it completes, and kept a week when it fails, with no count', async () => {
  // Without these, every finished run stayed in Redis for good and filled it (21 Nov 2026). A
  // count would trim the whole queue's sets, relay dedupe jobs included, so there is none.
  const templates = [];
  const queue = {
    upsertJobScheduler: async (_id, _repeat, template) => {
      templates.push(template);
    },
  };
  const schedule = ensureSchedule({
    queue,
    id: 'approvals.expire',
    every: 60_000,
    logger,
  });
  await schedule.ready;
  assert.equal(templates.length, 1);
  assert.equal(templates[0].opts.removeOnComplete, true);
  assert.deepEqual(templates[0].opts.removeOnFail, { age: 604_800 });
  await schedule.stop();
});
