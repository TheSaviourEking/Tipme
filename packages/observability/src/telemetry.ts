import { metrics, type Meter } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  serviceName: string;
  otlpEndpoint?: string;
  metricsPort?: number;
  sampleRatio: number;
  /** Test hook: export synchronously to this exporter instead of OTLP. */
  spanExporter?: SpanExporter;
}

const urlAttribute = /(^|\.)(url|target|full|query)$/;

/**
 * Runs before export processors and removes request-derived text: query strings from URL-like
 * attributes (paths stay for debugging), exception messages/stacks and status messages.
 */
const queryScrubber: SpanProcessor = {
  onStart: () => undefined,
  onEnd(span: ReadableSpan) {
    for (const [key, value] of Object.entries(span.attributes)) {
      if (typeof value !== 'string' || !urlAttribute.test(key)) continue;
      span.attributes[key] = key.endsWith('query') ? '' : value.split('?')[0];
    }
    // Exception messages and stacks can quote request input (e.g. JSON parse errors echo the
    // body); keep only the exception type.
    for (const event of span.events) {
      if (!event.attributes) continue;
      delete event.attributes['exception.message'];
      delete event.attributes['exception.stacktrace'];
    }
    delete (span.status as { message?: string }).message;
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

let sdk: NodeSDK | undefined;

/** Starts tracing and metrics once per process; later calls are ignored. */
export function startTelemetry(options: TelemetryOptions): void {
  if (sdk) return;
  const processors: SpanProcessor[] = [queryScrubber];
  if (options.spanExporter)
    processors.push(new SimpleSpanProcessor(options.spanExporter));
  else if (options.otlpEndpoint) {
    processors.push(
      new BatchSpanProcessor(
        // Short timeout: an unreachable collector must not hold up shutdown.
        new OTLPTraceExporter({
          url: `${options.otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
          timeoutMillis: 2000,
        }),
      ),
    );
  }
  sdk = new NodeSDK({
    // No host/process detectors: they record usernames and command lines.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.sampleRatio),
    }),
    spanProcessors: processors,
    metricReaders:
      options.metricsPort === undefined
        ? []
        : [
            new PrometheusExporter({
              host: '127.0.0.1',
              port: options.metricsPort,
            }),
          ],
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      // Command name only: arguments can contain keys and payloads.
      new IORedisInstrumentation({
        dbStatementSerializer: (command) => command,
      }),
    ],
  });
  sdk.start();
}

/** Flushes pending telemetry. Never rejects: telemetry must not block shutdown. */
export async function shutdownTelemetry(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  await current?.shutdown().catch(() => undefined);
}

export function getMeter(name: string): Meter {
  return metrics.getMeter(name);
}
