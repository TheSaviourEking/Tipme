import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { postProbe, startStack, waitForState } from './helpers.mjs';

const spans = new InMemorySpanExporter();
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: spans,
});
let stack;
before(async () => {
  stack = await startStack();
});
after(() => stack.stop());

test('one request produces one connected trace from API to worker, with matching logs and no leaks', async () => {
  const secrets = ['Thank you for the tip, Ada', 'leak-me', '4111111111111111'];
  const { status, body } = await postProbe(
    stack.api,
    { mode: 'succeed', note: secrets[0] },
    { authorization: `Bearer ${secrets[1]}`, 'x-card': secrets[2] },
  );
  assert.equal(status, 202);
  await waitForState(stack.api, body.data.jobId, ['completed']);

  // Check 1: one trace, API request -> enqueue -> worker job.
  const trace = spans
    .getFinishedSpans()
    .filter((span) => span.spanContext().traceId === body.data.reference);
  const byId = new Map(trace.map((span) => [span.spanContext().spanId, span]));
  const server = trace.find(
    (span) =>
      (span.kind === 1 && span.attributes['http.method'] === 'POST') ||
      (span.kind === 1 && span.attributes['http.request.method'] === 'POST'),
  );
  const job = trace.find((span) => span.name === 'job diagnostics.trace-probe');
  assert.ok(
    server,
    `no POST server span in ${trace.map((span) => span.name).join(', ')}`,
  );
  assert.ok(job, 'no worker job span in the trace');
  assert.ok(
    trace.some((span) => span.instrumentationScope.name.includes('ioredis')),
    'no Redis spans',
  );
  let cursor = job;
  while (cursor && cursor !== server)
    cursor = byId.get(cursor.parentSpanContext?.spanId);
  assert.equal(
    cursor,
    server,
    'job span does not descend from the API request span',
  );

  // Check 2: both services' log lines carry the same trace ID.
  const traced = stack.logs.filter(
    (line) => line.trace_id === body.data.reference,
  );
  assert.ok(
    traced.some(
      (line) => line.service === 'tipme-api' && line.event === 'http.request',
    ),
  );
  assert.ok(
    traced.some(
      (line) =>
        line.service === 'tipme-worker' && line.event === 'job.completed',
    ),
  );

  // Check 5: nothing private in spans or logs.
  const everything =
    JSON.stringify(
      spans.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
      })),
    ) + JSON.stringify(stack.logs);
  for (const secret of secrets)
    assert.ok(!everything.includes(secret), `leaked: ${secret}`);
});

test('malformed request bodies never reach spans, even through parser errors', async () => {
  const response = await fetch(`${stack.api}/v1/diagnostics/trace-probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'note=4111111111111111',
  });
  assert.equal(response.status, 400);
  const reference = response.headers.get('x-request-id');
  const traced = spans
    .getFinishedSpans()
    .filter((span) => span.spanContext().traceId === reference);
  assert.ok(traced.length > 0, 'expected spans for the rejected request');
  const exported = JSON.stringify(
    traced.map((span) => ({
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    })),
  );
  assert.ok(!exported.includes('41111'), exported);
});

test('readiness is green against real Postgres and Redis', async () => {
  const response = await fetch(`${stack.api}/health/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ready',
    checks: { postgres: 'up', redis: 'up' },
  });
});
