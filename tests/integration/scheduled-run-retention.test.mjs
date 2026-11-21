import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { ensureSchedule } from '../../apps/worker/dist/ensure-schedule.js';
import { REDIS_URL, Redis, bullmq } from './helpers.mjs';

// 21 Nov 2026: every finished scheduled run stayed in Redis for good, and Redis filled up. This
// runs a real scheduler fast enough to pass the limit and counts what is left.
const prefix = `it-retention-${randomUUID()}`;
const name = 'retention';
let connection;
let queue;
let worker;
before(async () => {
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new bullmq.Queue(name, { connection, prefix });
});
after(async () => {
  await worker?.close();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  // obliterate leaves the scheduler's own keys; take everything under this test's prefix.
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(
      cursor,
      'MATCH',
      `${prefix}:*`,
      'COUNT',
      500,
    );
    if (keys.length > 0) await connection.del(...keys);
    cursor = next;
  } while (cursor !== '0');
  await connection.quit();
});

test('a scheduler firing every 20 ms leaves at most 100 completed runs in Redis', async () => {
  let processed = 0;
  worker = new bullmq.Worker(
    name,
    async () => {
      processed += 1;
    },
    { connection, prefix, concurrency: 1 },
  );
  const schedule = ensureSchedule({
    queue,
    id: 'retention.tick',
    every: 20,
    logger: { warn() {} },
  });
  await schedule.ready;
  // Well past the limit, so the count below proves runs were removed (not that too few ran).
  const deadline = Date.now() + 15_000;
  while (processed < 120 && Date.now() < deadline) await sleep(50);
  await schedule.stop();
  await queue.removeJobScheduler('retention.tick');
  await worker.close();
  assert.ok(processed >= 120, `only ${processed} runs happened`);
  const completed = await queue.getCompletedCount();
  assert.ok(completed <= 100, `${completed} completed runs kept`);
  assert.ok(completed > 0, 'recent runs are still kept for inspection');
});
