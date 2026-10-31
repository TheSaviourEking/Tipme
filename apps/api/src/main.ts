import 'reflect-metadata';
import { ConfigError } from '@tipme/observability';
import { createApp } from './app.factory.js';
import { loadApiConfig } from './config.js';
import { ReadinessService } from './health/readiness.service.js';
import { createShutdown } from './shutdown.js';

try {
  const config = loadApiConfig(process.env);
  const app = await createApp(config);
  await app.listen(config.PORT, config.HOST);
  // Handled here rather than by Nest's shutdown hooks: drain first, flush telemetry after close.
  const stop = createShutdown(
    app,
    app.get(ReadinessService),
    config.SHUTDOWN_DRAIN_MS,
  );
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Names only: values may be credentials.
  console.error(error.message);
  process.exitCode = 1;
}
