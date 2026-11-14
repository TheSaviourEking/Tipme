import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ANNOUNCEMENTS_TICK_MS,
  announcementBatchSize,
  handleAnnouncements,
} from '../dist/handlers/announcements.js';
import { loadWorkerConfig } from '../dist/config.js';

// Staff announcements (14 Nov 2026): the worker queues announcement mail at a steady rate
// (tests/integration/announcements.test.mjs covers the batches themselves).
const base = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
  MAIL_SEAL_KEY: Buffer.alloc(32, 5).toString('base64'),
  MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
  NODE_ENV: 'test',
};

test('the job runs every 10 seconds, dispatched by name, and stops with the worker', () => {
  const source = readFileSync(
    new URL('../src/job-worker.ts', import.meta.url),
    'utf8',
  );
  assert.equal(ANNOUNCEMENTS_TICK_MS, 10_000);
  assert.match(source, /ANNOUNCEMENTS_JOB = 'announcements\.send'/);
  assert.match(source, /id: ANNOUNCEMENTS_JOB,\s+every: ANNOUNCEMENTS_TICK_MS/);
  assert.match(source, /job\.name === ANNOUNCEMENTS_JOB/);
  assert.match(source, /announcementsSchedule\.stop\(\)/);
});

test('the rate is a setting: 60 a minute unless set, 1 to 600', () => {
  assert.equal(loadWorkerConfig(base).ANNOUNCEMENT_SENDS_PER_MINUTE, 60);
  assert.equal(
    loadWorkerConfig({ ...base, ANNOUNCEMENT_SENDS_PER_MINUTE: '120' })
      .ANNOUNCEMENT_SENDS_PER_MINUTE,
    120,
  );
  for (const bad of ['0', '601', '2.5', 'fast'])
    assert.throws(
      () => loadWorkerConfig({ ...base, ANNOUNCEMENT_SENDS_PER_MINUTE: bad }),
      /ANNOUNCEMENT_SENDS_PER_MINUTE/,
      bad,
    );
});

test('each 10-second tick queues a sixth of the minute’s rate, at least one', () => {
  assert.equal(announcementBatchSize(60), 10);
  assert.equal(announcementBatchSize(600), 100);
  assert.equal(announcementBatchSize(1), 1);
  assert.equal(announcementBatchSize(100), 17);
});

test('one batch a tick, at that size, logged by counts only', async () => {
  const calls = [];
  const logs = [];
  const outcome = await handleAnnouncements({
    db: {},
    sealing: { key: Buffer.alloc(32) },
    sendsPerMinute: 60,
    now: () => new Date('2026-11-14T10:00:00Z'),
    log: (entry) => logs.push(entry),
    queueBatch: async (_db, _sealing, input) => {
      calls.push(input);
      return { announcementId: 'a1', queued: 10, finished: false };
    },
  });
  assert.equal(outcome, 'announcements_queued');
  assert.deepEqual(calls, [
    { now: new Date('2026-11-14T10:00:00Z'), limit: 10 },
  ]);
  assert.deepEqual(logs, [
    {
      event: 'announcements.batch',
      announcement_id: 'a1',
      queued: 10,
      finished: false,
    },
  ]);
});

test('nothing sending: nothing logged, nothing queued', async () => {
  const logs = [];
  const outcome = await handleAnnouncements({
    db: {},
    sealing: { key: Buffer.alloc(32) },
    sendsPerMinute: 60,
    now: () => new Date(),
    log: (entry) => logs.push(entry),
    queueBatch: async () => ({
      announcementId: null,
      queued: 0,
      finished: false,
    }),
  });
  assert.equal(outcome, 'announcements_idle');
  assert.deepEqual(logs, []);
});
