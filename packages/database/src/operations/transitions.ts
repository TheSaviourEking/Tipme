import type { Tx } from '../client.js';
import { statusTransitions } from '../schema.js';
import { newId } from './ids.js';

export interface TransitionRecord {
  entityType: 'tip' | 'attempt' | 'payout';
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  cause: 'provider_event' | 'system' | 'expiry';
  providerEventId?: string;
  traceId: string | null;
}

/** Appends to the immutable history; always called in the same transaction as the status change. */
export async function recordTransition(
  tx: Tx,
  record: TransitionRecord,
): Promise<void> {
  await tx.insert(statusTransitions).values({ id: newId(), ...record });
}
