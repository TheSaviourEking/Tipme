import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context, trace } from '@opentelemetry/api';
import { tracing } from '@opentelemetry/sdk-node';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { traceCarrierSchema } from '@tipme/contracts';
import { injectTraceCarrier, withExtractedContext } from '../dist/index.js';

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(new tracing.BasicTracerProvider());

test('trace context round-trips through a job carrier', () => {
  trace.getTracer('t').startActiveSpan('producer', (span) => {
    const carrier = injectTraceCarrier();
    assert.equal(traceCarrierSchema.safeParse(carrier).success, true);
    span.end();
    const seen = context.with(context.active(), () =>
      withExtractedContext(
        carrier,
        () => trace.getSpanContext(context.active())?.traceId,
      ),
    );
    assert.equal(seen, span.spanContext().traceId);
  });
});
