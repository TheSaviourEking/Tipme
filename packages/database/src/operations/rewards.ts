import { buildRewardPosting } from '@tipme/domain';
import type { Database, Tx } from '../client.js';
import { guarded } from './errors.js';
import { activeTraceId } from './ids.js';
import { postLedgerTransaction } from './ledger.js';

/**
 * Credits a cash reward to a recipient's balance as TipMe's own promotional cost (balanced,
 * append-only). The operation key makes a repeat a no-op, so a reward can never pay twice.
 */
export async function postCashReward(
  tx: Tx,
  input: {
    profileId: string;
    amountMinor: bigint;
    currency: string;
    operationKey: string;
  },
): Promise<{ transactionId: string; created: boolean }> {
  return postLedgerTransaction(tx, {
    operationType: 'reward',
    operationKey: input.operationKey,
    currency: input.currency,
    lines: buildRewardPosting({
      amountMinor: input.amountMinor,
      profileId: input.profileId,
    }),
    traceId: activeTraceId(),
  });
}

export function grantCashReward(
  db: Database,
  input: {
    profileId: string;
    amountMinor: bigint;
    currency: string;
    operationKey: string;
  },
): Promise<{ transactionId: string; created: boolean }> {
  return guarded(() => db.transaction((tx) => postCashReward(tx, input)));
}
