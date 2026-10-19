import 'reflect-metadata';
import { ConfigError, shutdownTelemetry } from '@tipme/observability';
import { createApp } from './app.factory.js';
import { loadApiConfig } from './config.js';

try {
  const config = loadApiConfig(process.env);
  const app = await createApp(config);
  await app.listen(config.PORT, config.HOST);
  // Handled here rather than by Nest's shutdown hooks so telemetry flushes after the app closes.
  const stop = async (): Promise<void> => {
    await app.close();
    await shutdownTelemetry();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Names only: values may be credentials.
  console.error(error.message);
  process.exitCode = 1;
}
