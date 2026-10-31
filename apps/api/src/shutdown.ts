import type { INestApplication } from '@nestjs/common';
import { shutdownTelemetry } from '@tipme/observability';
import type { ReadinessService } from './health/readiness.service.js';

/**
 * Graceful stop for SIGTERM/SIGINT. Readiness fails first and the process keeps serving for
 * `drainMs`, so the load balancer's health checks see 503 and stop routing here; only then
 * does the server close (in-flight requests finish) and telemetry flush. Calls after the
 * first return the same run, so a second signal cannot close twice.
 */
export function createShutdown(
  app: INestApplication,
  readiness: ReadinessService,
  drainMs: number,
  flushTelemetry: () => Promise<void> = shutdownTelemetry,
): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => {
    running ??= (async () => {
      readiness.startDraining();
      if (drainMs > 0)
        await new Promise((resolve) => setTimeout(resolve, drainMs));
      await app.close();
      await flushTelemetry();
    })();
    return running;
  };
}
