import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { startTelemetry, shutdownTelemetry } from '../dist/index.js';
import { InMemorySpanExporter } from '../dist/testing.js';

const spans = new InMemorySpanExporter();
startTelemetry({
  serviceName: 'tipme-test',
  sampleRatio: 1,
  spanExporter: spans,
});

test('exception messages and status text never leave the process', async () => {
  trace.getTracer('t').startActiveSpan('parse', (span) => {
    span.recordException(
      new SyntaxError('Unexpected token, "note=41111" is not valid JSON'),
    );
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: 'note=41111 secret',
    });
    span.end();
  });
  const [span] = spans.getFinishedSpans();
  await shutdownTelemetry();
  const exported = JSON.stringify({ events: span.events, status: span.status });
  assert.ok(!exported.includes('41111'), exported);
  assert.equal(span.events[0].attributes['exception.type'], 'SyntaxError');
  assert.equal(span.status.code, SpanStatusCode.ERROR);
});
