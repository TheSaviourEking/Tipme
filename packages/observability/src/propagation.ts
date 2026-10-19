import { randomBytes } from 'node:crypto';
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
} from '@opentelemetry/api';
import { core } from '@opentelemetry/sdk-node';
import { traceCarrierSchema, type TraceCarrier } from '@tipme/contracts';

// Explicit W3C propagator: job payloads use one wire format whatever the global SDK configuration is.
const propagator = new core.W3CTraceContextPropagator();

/** Captures the active trace context; with no active trace, starts an unsampled root so jobs stay valid. */
export function injectTraceCarrier(): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, defaultTextMapSetter);
  const parsed = traceCarrierSchema.safeParse(carrier);
  if (parsed.success) return parsed.data;
  return {
    traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`,
  };
}

export function withExtractedContext<T>(carrier: TraceCarrier, fn: () => T): T {
  return context.with(
    propagator.extract(context.active(), carrier, defaultTextMapGetter),
    fn,
  );
}
