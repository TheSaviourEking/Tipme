import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { pino, type DestinationStream, type Logger } from 'pino';

// Defence in depth: callers log allowlisted fields, but anything sensitive that slips through is removed.
const sensitiveKeys = [
  'authorization',
  'cookie',
  'password',
  'note',
  'message',
  'card',
  'cardNumber',
  'pan',
  'cvv',
];
const redactPaths = [
  ...sensitiveKeys,
  ...sensitiveKeys.map((key) => `*.${key}`),
  'req',
  'res',
  'body',
  'headers',
  'query',
];

export interface LoggerOptions {
  service: string;
  level?: string;
  destination?: DestinationStream;
}

export function createLogger({
  service,
  level = 'info',
  destination,
}: LoggerOptions): Logger {
  const options = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, remove: true },
    mixin() {
      const spanContext = trace.getSpanContext(context.active());
      return spanContext && isSpanContextValid(spanContext)
        ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
        : {};
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { DestinationStream, Logger } from 'pino';
