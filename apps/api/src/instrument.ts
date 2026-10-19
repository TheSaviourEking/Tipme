// Preloaded with `node --import`: registers the ESM hook and starts telemetry before the app loads.
import '@tipme/observability/register';
import { startTelemetry } from '@tipme/observability';
import { apiConfigSchema, SERVICE_NAME } from './config.js';

// Invalid configuration is reported by main.ts; telemetry simply stays off.
const config = apiConfigSchema.safeParse(
  Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ''),
  ),
);
if (config.success) {
  startTelemetry({
    serviceName: SERVICE_NAME,
    otlpEndpoint: config.data.OTEL_EXPORTER_OTLP_ENDPOINT,
    metricsPort: config.data.API_METRICS_PORT,
    sampleRatio: config.data.OTEL_TRACES_SAMPLER_RATIO,
  });
}
