import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTelemetry } from '@tipme/observability';
import { InMemorySpanExporter } from '@tipme/observability/testing';

// Telemetry first, then the app, so HTTP instrumentation can continue incoming traces.
startTelemetry({
  serviceName: 'tipme-api',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const { startApp } = await import('./helpers.mjs');
const hex32 = /^[0-9a-f]{32}$/;

test('unknown routes return the error envelope with a matching reference header', async (t) => {
  const { origin } = await startApp(t);
  const response = await fetch(`${origin}/missing`);
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.match(body.error.reference, hex32);
  assert.equal(response.headers.get('x-request-id'), body.error.reference);
});

test('oversized bodies return PAYLOAD_TOO_LARGE', async (t) => {
  const { origin } = await startApp(t);
  const response = await fetch(`${origin}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(20 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('malformed JSON is a validation failure that never echoes the body', async (t) => {
  const { origin } = await startApp(t);
  const response = await fetch(`${origin}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"mode": "sneaky-value"',
  });
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(text).error.code, 'VALIDATION_FAILED');
  assert.ok(!text.includes('sneaky-value'), text);
});

test('hostile traceparent headers are ignored and a fresh trace starts', async (t) => {
  const { origin } = await startApp(t);
  for (const traceparent of ['garbage', `00-${'f'.repeat(10_000)}-01`]) {
    const response = await fetch(`${origin}/health`, {
      headers: { traceparent },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-request-id'), hex32);
  }
});

test('a valid incoming traceparent is continued', async (t) => {
  const { origin } = await startApp(t);
  const traceId = 'a1'.repeat(16);
  const response = await fetch(`${origin}/health`, {
    headers: { traceparent: `00-${traceId}-${'b2'.repeat(8)}-01` },
  });
  assert.equal(response.headers.get('x-request-id'), traceId);
});

test('each request logs one allowlisted line and never headers', async (t) => {
  const { origin, logs } = await startApp(t);
  const response = await fetch(`${origin}/health`, {
    headers: { authorization: 'Bearer leak-me' },
  });
  await response.text();
  await new Promise((resolve) => setImmediate(resolve));
  const lines = logs.filter((line) => line.event === 'http.request');
  assert.equal(lines.length, 1);
  assert.deepEqual(
    Object.keys(lines[0])
      .filter(
        (key) =>
          !['level', 'time', 'service', 'trace_id', 'span_id', 'msg'].includes(
            key,
          ),
      )
      .sort(),
    ['duration_ms', 'event', 'method', 'reference', 'route', 'status'],
  );
  assert.equal(lines[0].reference, response.headers.get('x-request-id'));
  assert.equal(lines[0].route, '/health');
  assert.ok(!JSON.stringify(logs).includes('leak-me'));
});
