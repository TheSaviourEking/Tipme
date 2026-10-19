import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trace } from '@opentelemetry/api';
import { startTelemetry, shutdownTelemetry } from '../dist/index.js';

test('an unreachable collector never breaks the application', async () => {
  startTelemetry({
    serviceName: 'tipme-test',
    sampleRatio: 1,
    otlpEndpoint: 'http://127.0.0.1:1',
  });
  trace.getTracer('t').startActiveSpan('work', (span) => span.end());
  const started = performance.now();
  await assert.doesNotReject(shutdownTelemetry());
  assert.ok(
    performance.now() - started < 5000,
    'shutdown must not wait on a dead collector',
  );
});
