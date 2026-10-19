import { z } from 'zod';

export const traceProbeModes = ['succeed', 'fail-once', 'fail-always'] as const;
export const traceProbeModeSchema = z.enum(traceProbeModes);
export type TraceProbeMode = z.infer<typeof traceProbeModeSchema>;

/** `note` exists to exercise free-text redaction; it is never logged, traced or enqueued. */
export const traceProbeRequestSchema = z
  .object({ mode: traceProbeModeSchema, note: z.string().max(120).optional() })
  .strict();
export type TraceProbeRequest = z.infer<typeof traceProbeRequestSchema>;

export interface TraceProbeAccepted {
  reference: string;
  jobId: string;
}

export interface TraceProbeStatus {
  state: 'waiting' | 'active' | 'completed' | 'failed';
  attemptsMade: number;
}
