// Preloaded with `node --import`: registers the ESM hook and starts telemetry before the worker loads.
import '@tipme/observability/register';
import { startTelemetry } from '@tipme/observability';
import { SERVICE_NAME, workerConfigSchema } from './config.js';

// Invalid configuration is reported by main.ts; telemetry simply stays off.
const config = workerConfigSchema.safeParse(
  Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ''),
  ),
);
if (config.success) {
  startTelemetry({
    serviceName: SERVICE_NAME,
    otlpEndpoint: config.data.OTEL_EXPORTER_OTLP_ENDPOINT,
    metricsPort: config.data.WORKER_METRICS_PORT,
    sampleRatio: config.data.OTEL_TRACES_SAMPLER_RATIO,
  });
}
