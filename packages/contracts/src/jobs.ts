import { z } from 'zod';
import { traceProbeModeSchema } from './diagnostics.js';

export const JOB_QUEUE = 'tipme-jobs';
export const JOB_NAMES = { traceProbe: 'diagnostics.trace-probe' } as const;

/** W3C trace context carried inside job payloads so worker spans join the producer's trace. */
export const traceCarrierSchema = z
  .object({
    traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    tracestate: z.string().max(512).optional(),
  })
  .strict();
export type TraceCarrier = z.infer<typeof traceCarrierSchema>;

export const traceProbeJobSchema = z
  .object({
    idempotencyKey: z.uuid(),
    mode: traceProbeModeSchema,
    _trace: traceCarrierSchema,
  })
  .strict();
export type TraceProbeJob = z.infer<typeof traceProbeJobSchema>;
