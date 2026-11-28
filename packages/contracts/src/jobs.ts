import { z } from 'zod';
import { traceProbeModeSchema } from './diagnostics.js';

export const JOB_QUEUE = 'tipme-jobs';
export const JOB_NAMES = { traceProbe: 'diagnostics.trace-probe' } as const;
/** Queued with a new withdrawal; the worker starts the payout from it. */
export const PAYOUT_START_EVENT = 'payouts.start';
/** Staff switched all withdrawals: the worker tells the alert route. */
export const WITHDRAWALS_SWITCH_EVENT = 'withdrawals.switch_changed';
/** A takeover report opened a new issue and froze a page: the worker tells the alert route. */
export const WITHDRAWAL_FREEZE_OPENED_EVENT = 'withdrawals.freeze_opened';
/** The provider refused TipMe itself (empty reserve, or a bad key): the worker tells the alert route. */
export const PLATFORM_REFUSAL_EVENT = 'payouts.platform_refused';
/** You collect (Task 9): a dispute holds part of a recipient's balance; the worker emails them. */
export const DISPUTE_HOLD_EVENT = 'collect.dispute_hold';
/**
 * Outbox: someone's admin grants ended outside a staff change (an authenticator reset, a resent
 * invitation, a phone or email move, a recovery). Written by dropOpsAccess in its transaction; the
 * relay turns it into `staff.changed`, so their open staff stream closes at once. No alert, no mail.
 */
export const OPS_GRANTS_ENDED_EVENT = 'ops.grants_ended';

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
