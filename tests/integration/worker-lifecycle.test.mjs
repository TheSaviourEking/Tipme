import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  bullmq,
  DATABASE_URL,
  MAIL_SEAL_KEY,
  REDIS_URL,
  uniquePrefix,
  waitForJob,
  WEBHOOK_SECRET,
} from './helpers.mjs';

const main = fileURLToPath(
  new URL('../../apps/worker/dist/main.js', import.meta.url),
);

/** Spawns the real worker process and resolves once it reports worker.started. */
async function spawnWorker(t, env = {}) {
  const child = spawn(process.execPath, [main], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      REDIS_URL,
      DATABASE_URL,
      MOCK_PROVIDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MAIL_SEAL_KEY,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  while (!stdout.includes('worker.started')) {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => {
        throw new Error(`Worker exited early: ${code}`);
      }),
    ]);
  }
  return { child, output: () => stdout };
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(
    `worker reports liveness and exits cleanly on ${signal}`,
    { timeout: 20_000 },
    async (t) => {
      const { child, output } = await spawnWorker(t);
      assert.equal(
        JSON.parse(output().trim().split('\n')[0]).event,
        'worker.started',
      );
      const exited = once(child, 'exit');
      const stopping = performance.now();
      child.kill(signal);
      const [code, terminatedBy] = await exited;
      assert.ok(
        performance.now() - stopping < 3000,
        'an idle worker must stop promptly',
      );
      assert.equal(code, 0);
      assert.equal(terminatedBy, null);
      assert.match(output(), /worker.stopped/);
    },
  );
}

test(
  'SIGTERM lets the in-flight job finish before exit',
  { timeout: 30_000 },
  async (t) => {
    const prefix = uniquePrefix();
    const { child, output } = await spawnWorker(t, {
      QUEUE_PREFIX: prefix,
      TRACE_PROBE_TEST_DELAY_MS: '1500',
    });
    const queue = new bullmq.Queue('tipme-jobs', {
      connection: { url: REDIS_URL },
      prefix,
    });
    t.after(() => queue.close());
    const idempotencyKey = randomUUID();
    await queue.add(
      'diagnostics.trace-probe',
      {
        idempotencyKey,
        mode: 'succeed',
        _trace: { traceparent: `00-${'d4'.repeat(16)}-${'e5'.repeat(8)}-01` },
      },
      { jobId: idempotencyKey },
    );
    await waitForJob(queue, idempotencyKey, ['active']);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(
      (
        await waitForJob(queue, idempotencyKey, [
          'completed',
          'failed',
          'active',
          'waiting',
        ])
      ).state,
      'completed',
    );
    const events = output()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    assert.ok(
      events.indexOf('job.completed') < events.indexOf('worker.stopped'),
      events.join(','),
    );
  },
);
