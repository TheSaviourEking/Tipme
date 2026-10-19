import { randomBytes } from 'node:crypto';
import { context, isSpanContextValid, trace } from '@opentelemetry/api';

/** The support reference for the current request: its trace ID, or a random ID when tracing is off. */
export function currentReference(): string {
  const spanContext = trace.getSpanContext(context.active());
  return spanContext && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : randomBytes(16).toString('hex');
}

interface ResponseWithLocals {
  locals: Record<string, unknown>;
}

export function referenceOf(response: ResponseWithLocals): string {
  const stored = response.locals['reference'];
  return typeof stored === 'string' ? stored : currentReference();
}
