import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { trace } from '@opentelemetry/api';
import { tracing } from '@opentelemetry/sdk-node';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { createLogger } from '../dist/index.js';

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(new tracing.BasicTracerProvider());

function collect() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(
        ...chunk
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
      done();
    },
  });
  return { lines, stream };
}

test('log lines carry the active trace and span IDs', () => {
  const { lines, stream } = collect();
  const log = createLogger({ service: 'tipme-test', destination: stream });
  trace.getTracer('t').startActiveSpan('work', (span) => {
    log.info({ event: 'inside' }, 'inside');
    assert.equal(lines.at(-1).trace_id, span.spanContext().traceId);
    assert.equal(lines.at(-1).span_id, span.spanContext().spanId);
    span.end();
  });
  assert.equal(lines.at(-1).service, 'tipme-test');
});

test('sensitive fields never reach the log stream', () => {
  const { lines, stream } = collect();
  const log = createLogger({ service: 'tipme-test', destination: stream });
  log.info(
    {
      headers: { authorization: 'Bearer t' },
      note: 'private words',
      card: '4111111111111111',
      body: { message: 'hello there' },
      nested: { password: 'hunter2', cookie: 'sid=1' },
    },
    'x',
  );
  const output = JSON.stringify(lines);
  for (const secret of [
    'Bearer t',
    'private words',
    '4111111111111111',
    'hello there',
    'hunter2',
    'sid=1',
  ]) {
    assert.ok(!output.includes(secret), `leaked ${secret}`);
  }
});
