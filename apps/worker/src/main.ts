import {
  ConfigError,
  createLogger,
  shutdownTelemetry,
} from '@tipme/observability';
import { loadWorkerConfig, SERVICE_NAME } from './config.js';
import { startJobWorker } from './job-worker.js';

try {
  const config = loadWorkerConfig(process.env);
  const logger = createLogger({
    service: SERVICE_NAME,
    level: config.LOG_LEVEL,
  });
  const worker = await startJobWorker(config);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await worker.close();
    await shutdownTelemetry();
    logger.info({ event: 'worker.stopped' });
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  logger.info({ event: 'worker.started' });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Names only: values may be credentials.
  console.error(error.message);
  process.exitCode = 1;
}
