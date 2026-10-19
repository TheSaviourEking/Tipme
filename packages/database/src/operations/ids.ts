import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { v7 } from 'uuid';

/** Time-ordered UUIDv7. */
export const newId = (): string => v7();

/** The active trace ID, so records link to the request that caused them (PR-004). */
export function activeTraceId(): string | null {
  const spanContext = trace.getSpanContext(context.active());
  return spanContext && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : null;
}
