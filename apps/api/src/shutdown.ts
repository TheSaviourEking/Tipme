import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { shutdownTelemetry } from '@tipme/observability';
import type { ReadinessService } from './health/readiness.service.js';

export interface ShutdownOptions {
  /** Longest wait for in-flight requests after the drain; then connections are cut. */
  closeDeadlineMs?: number;
  flushTelemetry?: () => Promise<void>;
}

// Inside compose's 20 s stop_grace_period, after the drain window.
const DEFAULT_CLOSE_DEADLINE_MS = 10_000;
const IDLE_SWEEP_MS = 100;

/**
 * Graceful stop for SIGTERM/SIGINT. Readiness fails first and the process keeps serving for
 * `drainMs`, so the load balancer's health checks see 503 and stop routing here; only then
 * does the server close (in-flight requests finish, up to the close deadline) and telemetry
 * flush, even if closing fails. Calls after the first return the same run, so a second
 * signal cannot close twice.
 */
export function createShutdown(
  app: INestApplication,
  readiness: ReadinessService,
  drainMs: number,
  options: ShutdownOptions = {},
): () => Promise<void> {
  const deadlineMs = options.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS;
  const flushTelemetry = options.flushTelemetry ?? shutdownTelemetry;
  let running: Promise<void> | undefined;
  return () => {
    running ??= (async () => {
      readiness.startDraining();
      if (drainMs > 0)
        await new Promise((resolve) => setTimeout(resolve, drainMs));
      const server = app.getHttpServer() as Server;
      // Idle keep-alive sockets (the proxy's) would otherwise hold close() for their 5 s timeout.
      // Swept repeatedly: a connection busy now turns idle once its response is sent.
      server.closeIdleConnections();
      const sweep = setInterval(
        () => server.closeIdleConnections(),
        IDLE_SWEEP_MS,
      );
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          app.close(),
          new Promise<void>((resolve) => {
            deadline = setTimeout(() => {
              server.closeAllConnections();
              resolve();
            }, deadlineMs);
          }),
        ]);
      } finally {
        clearInterval(sweep);
        clearTimeout(deadline);
        await flushTelemetry();
      }
    })();
    return running;
  };
}
