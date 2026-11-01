import type {
  Database,
  PayoutStarter,
  PayoutStartOutcome,
} from '@tipme/database';
import { startPayout } from '@tipme/database';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';

const payloadSchema = z.object({ payoutId: z.uuid() });

/**
 * Starts the payout a withdrawal queued. An unknown outcome is a normal return, never a throw: the
 * queue must not retry it into another provider call. A redelivery is safe anyway, since startPayout
 * only reads once a start has been attempted.
 */
export function handlePayoutStart(
  data: unknown,
  deps: { db: Database; provider: (name: string) => PayoutStarter },
): Promise<PayoutStartOutcome> {
  const payload = payloadSchema.safeParse(data);
  if (!payload.success) throw new UnrecoverableError('invalid_payload');
  return startPayout(deps.db, {
    payoutId: payload.data.payoutId,
    provider: deps.provider,
  });
}
