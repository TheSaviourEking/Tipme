import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import {
  getFreePort,
  InMemorySpanExporter,
} from '../../packages/observability/dist/testing.js';
import {
  REDIS_URL,
  bullmq,
  postProbe,
  startStack,
  waitForJob,
  waitForState,
} from './helpers.mjs';

const metricsPort = await getFreePort();
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
  metricsPort,
});
let stack;
before(async () => {
  stack = await startStack();
});
after(() => stack.stop());

test('a job that fails once is retried and completes', async () => {
  const { body } = await postProbe(stack.api, { mode: 'fail-once' });
  const status = await waitForState(stack.api, body.data.jobId, [
    'completed',
    'failed',
  ]);
  assert.deepEqual(status, { state: 'completed', attemptsMade: 2 });
});

test('a job that keeps failing is retried with backoff, then kept as failed and counted', async () => {
  const { body } = await postProbe(stack.api, { mode: 'fail-always' });
  const status = await waitForState(
    stack.api,
    body.data.jobId,
    ['failed'],
    20_000,
  );
  assert.deepEqual(status, { state: 'failed', attemptsMade: 3 });
  const failures = stack.logs.filter(
    (line) =>
      line.trace_id === body.data.reference && line.event === 'job.failed',
  );
  assert.deepEqual(
    failures.map((line) => line.attempt),
    [1, 2, 3],
  );
  assert.ok(failures.every((line) => line.reason === 'probe_failure'));
  const metrics = await (
    await fetch(`http://127.0.0.1:${metricsPort}/metrics`)
  ).text();
  const failed = Number(
    /^tipme_jobs_failed(?:\{[^}]*\})? (\d+)/m.exec(metrics)?.[1],
  );
  assert.ok(failed >= 1, metrics);
  assert.match(metrics, /http_server_(request_)?duration/);
});

test('two deliveries of the same work run once', async (t) => {
  const queue = new bullmq.Queue('tipme-jobs', {
    connection: { url: REDIS_URL },
    prefix: stack.prefix,
  });
  t.after(() => queue.close());
  const traceId = randomUUID().replaceAll('-', '');
  const payload = {
    idempotencyKey: randomUUID(),
    mode: 'succeed',
    _trace: { traceparent: `00-${traceId}-${'c3'.repeat(8)}-01` },
  };
  const jobs = await Promise.all(
    ['a', 'b'].map((suffix) =>
      queue.add('diagnostics.trace-probe', payload, {
        jobId: `${payload.idempotencyKey}-${suffix}`,
      }),
    ),
  );
  for (const job of jobs) await waitForJob(queue, job.id, ['completed']);
  const events = stack.logs
    .filter((line) => line.trace_id === traceId)
    .map((line) => line.event)
    .sort();
  assert.deepEqual(events, ['job.completed', 'job.duplicate']);
});

test('unknown job IDs are not found', async () => {
  const response = await fetch(
    `${stack.api}/v1/diagnostics/trace-probe/${randomUUID()}`,
  );
  assert.equal(response.status, 404);
});

test('corrupt jobs fail immediately without retries', async (t) => {
  const queue = new bullmq.Queue('tipme-jobs', {
    connection: { url: REDIS_URL },
    prefix: stack.prefix,
  });
  t.after(() => queue.close());
  const job = await queue.add(
    'diagnostics.trace-probe',
    { mode: 'succeed', secret: 'do-not-log' },
    { attempts: 3 },
  );
  const status = await waitForJob(queue, job.id, ['failed']);
  assert.deepEqual(status, { state: 'failed', attemptsMade: 1 });
  assert.ok(
    stack.logs.some(
      (line) =>
        line.event === 'job.failed' && line.reason === 'invalid_payload',
    ),
  );
  assert.ok(!JSON.stringify(stack.logs).includes('do-not-log'));
});
