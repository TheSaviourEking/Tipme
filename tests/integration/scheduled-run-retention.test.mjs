import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { ensureSchedule } from '../../apps/worker/dist/ensure-schedule.js';
import { RELAY_JOB_RETENTION } from '../../apps/worker/dist/outbox-relay-loop.js';
import { REDIS_URL, Redis, bullmq } from './helpers.mjs';

// 21 Nov 2026: every finished scheduled run stayed in Redis for good, and Redis filled up. This
// runs a real scheduler fast enough to pile runs up, on one queue with relay jobs as production
// has: BullMQ trims a queue's whole completed and failed sets, so the schedulers' retention must
// never cut the relay's 7-day dedupe window short.
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

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await sleep(50);
}

test('fast scheduled runs do not pile up, and relay jobs on the same queue keep their 7 days', async () => {
  let scheduledRuns = 0;
  worker = new bullmq.Worker(
    name,
    async (job) => {
      if (job.name === 'relay.fails') throw new Error('handler failed');
      if (job.name === 'retention.tick') scheduledRuns += 1;
    },
    { connection, prefix, concurrency: 1 },
  );
  // Shaped like the outbox relay's jobs: the dedupe key is the job ID.
  const relayDone = `relay-done-${randomUUID()}`;
  const relayFailed = `relay-failed-${randomUUID()}`;
  await queue.add(
    'relay.done',
    {},
    { jobId: relayDone, ...RELAY_JOB_RETENTION },
  );
  await queue.add(
    'relay.fails',
    {},
    { jobId: relayFailed, ...RELAY_JOB_RETENTION, attempts: 1 },
  );
  await waitFor(
    async () =>
      (await queue.getJobState(relayDone)) === 'completed' &&
      (await queue.getJobState(relayFailed)) === 'failed',
  );

  const schedule = ensureSchedule({
    queue,
    id: 'retention.tick',
    every: 20,
    logger: { warn() {} },
  });
  await schedule.ready;
  // Well past any count limit, so what is left proves what was removed.
  await waitFor(() => scheduledRuns >= 120);
  await schedule.stop();
  await queue.removeJobScheduler('retention.tick');
  await worker.close();
  assert.ok(scheduledRuns >= 120, `only ${scheduledRuns} runs happened`);

  assert.equal(await queue.getJobState(relayDone), 'completed');
  assert.equal(await queue.getJobState(relayFailed), 'failed');
  // Re-publishing a relayed row is a no-op: no second job under the same dedupe key.
  await queue.add(
    'relay.done',
    {},
    { jobId: relayDone, ...RELAY_JOB_RETENTION },
  );
  assert.equal(await queue.getJobState(relayDone), 'completed');
  assert.equal(await queue.getWaitingCount(), 0);

  const completed = await queue.getCompleted(0, -1);
  const scheduledLeft = completed.filter((job) => job.id.startsWith('repeat:'));
  assert.equal(scheduledLeft.length, 0, 'completed scheduled runs are kept');
});
