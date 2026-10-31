import { z } from 'zod';

/** Process liveness only; does not claim dependency or payment readiness. */
export interface HealthResponse {
  status: 'ok';
  service: 'api';
}

const dependencyState = z.enum(['up', 'down']);

/** Dependency readiness: reports reachability only, never error details. */
export const readinessResponseSchema = z.union([
  z
    .object({
      status: z.enum(['ready', 'unavailable']),
      checks: z
        .object({ postgres: dependencyState, redis: dependencyState })
        .strict(),
    })
    .strict(),
  // Shutting down: answered without probing, so the load balancer drops the instance.
  z.object({ status: z.literal('draining') }).strict(),
]);
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
