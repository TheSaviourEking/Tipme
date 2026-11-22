import type {
  CollectTransferProvider,
  CollectTransferRun,
  Database,
} from '@tipme/database';
import {
  releaseWaitingTransfers,
  runCollectTransfers,
  runDisputeSteps,
  sendDisputeEvidence,
  type DisputeEvidenceProvider,
} from '@tipme/database';

/*
 * You collect (plan Task 8, spec §5): every 2 minutes, waiting shares whose recipient can receive
 * them are released, then each provider's transfer machine runs. Always scheduled (the switch off
 * still moves what is held, §12.5); with no rows it asks nothing of anyone.
 */

/** What a provider adapter may offer; only one with all three calls makes collect transfers. */
type MaybeCollectProvider = {
  name: string;
  sendCollectTransfer?: CollectTransferProvider['sendCollectTransfer'];
  listAccountTransfers?: CollectTransferProvider['listAccountTransfers'];
  payoutCapability?: (
    accountRef: string,
  ) => ReturnType<CollectTransferProvider['payoutCapability']>;
  /** Task 9: a lost dispute's transfer back, as the recipient's account (`destination: "self"`). */
  collectToPlatform?: (input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
    description?: string;
  }) => Promise<{ transferRef: string; status: 'paid' | 'pending' }>;
};

/** The providers that can make collect transfers, each call bound to its own adapter. */
export function collectTransferProviders(
  providers: readonly (MaybeCollectProvider | null | undefined)[],
): CollectTransferProvider[] {
  return providers.flatMap((provider) => {
    if (
      !provider?.sendCollectTransfer ||
      !provider.listAccountTransfers ||
      !provider.payoutCapability
    )
      return [];
    const {
      sendCollectTransfer,
      listAccountTransfers,
      payoutCapability,
      collectToPlatform,
    } = provider;
    return [
      {
        name: provider.name,
        ...(collectToPlatform
          ? {
              collectBack: (
                input: Parameters<
                  NonNullable<CollectTransferProvider['collectBack']>
                >[0],
              ) =>
                collectToPlatform.call(provider, {
                  ...input,
                  description: 'TipMe dispute',
                }),
            }
          : {}),
        sendCollectTransfer: (input) =>
          sendCollectTransfer.call(provider, input),
        listAccountTransfers: (accountRef) =>
          listAccountTransfers.call(provider, accountRef),
        payoutCapability: (accountRef) =>
          payoutCapability.call(provider, accountRef),
      },
    ];
  });
}

export type CollectTransfersLog = (entry: {
  event: string;
  provider?: string;
  error?: string;
}) => void;

export interface CollectTransfersOutcome extends Omit<
  CollectTransferRun,
  'stopped'
> {
  released: number;
  failed: number;
  stopped?: CollectTransferRun['stopped'];
}

/**
 * One sweep. A failure is logged by its error's name only (never a message: it can carry an
 * account) and counted, never thrown: the run is safe to repeat, and the next sweep is 2 minutes
 * away, so the queue retrying it would only add partner calls. Staff's pause and TipMe's debt are
 * about every collect transfer, so they end the sweep; a FORBIDDEN that is TipMe's own key stops
 * only that provider's run.
 */
export async function handleCollectTransfers(deps: {
  db: Database;
  providers: readonly CollectTransferProvider[];
  log: CollectTransfersLog;
  now?: Date;
  /** Replaced in tests. */
  release?: typeof releaseWaitingTransfers;
  run?: typeof runCollectTransfers;
}): Promise<CollectTransfersOutcome> {
  const now = deps.now ?? new Date();
  const release = deps.release ?? releaseWaitingTransfers;
  const run = deps.run ?? runCollectTransfers;
  const outcome: CollectTransfersOutcome = {
    released: 0,
    sent: 0,
    paid: 0,
    retried: 0,
    review: 0,
    failed: 0,
  };
  const errorName = (error: unknown) =>
    error instanceof Error ? error.name : 'unknown';
  try {
    outcome.released = await release(deps.db, { now });
  } catch (error) {
    outcome.failed += 1;
    deps.log({
      event: 'collect_transfers.release_failed',
      error: errorName(error),
    });
  }
  for (const provider of deps.providers) {
    let result: CollectTransferRun;
    try {
      result = await run(deps.db, { provider, now });
    } catch (error) {
      outcome.failed += 1;
      deps.log({
        event: 'collect_transfers.run_failed',
        provider: provider.name,
        error: errorName(error),
      });
      continue;
    }
    outcome.sent += result.sent;
    outcome.paid += result.paid;
    outcome.retried += result.retried;
    outcome.review += result.review;
    if (result.stopped) outcome.stopped = result.stopped;
    if (result.stopped === 'paused' || result.stopped === 'in_debt') break;
  }
  return outcome;
}

/**
 * Task 9: after the transfers, every unsettled dispute on a collect tip is moved on (a read-back
 * settled its share, a transfer back was paid), and staff are reminded 48 hours before evidence is
 * due. Database only; a failure is logged by name and never thrown, as above.
 */
export async function handleDisputeSteps(deps: {
  db: Database;
  log: CollectTransfersLog;
  now?: Date;
  /** Replaced in tests. */
  steps?: typeof runDisputeSteps;
}): Promise<{ reminded: number; advanced: number; failed: number }> {
  const steps = deps.steps ?? runDisputeSteps;
  try {
    return await steps(deps.db, { now: deps.now ?? new Date() });
  } catch (error) {
    deps.log({
      event: 'collect_disputes.run_failed',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return { reminded: 0, advanced: 0, failed: 1 };
  }
}

/**
 * Task 15: dispute evidence staff had approved is submitted to the partner, once per attempt's key
 * (a lost answer is asked again with the same key next sweep). Logged by error name only.
 */
export async function handleDisputeEvidence(deps: {
  db: Database;
  providers: readonly {
    name: string;
    provider: Partial<DisputeEvidenceProvider> | null | undefined;
  }[];
  log: CollectTransfersLog;
  now?: Date;
  /** Replaced in tests. */
  send?: typeof sendDisputeEvidence;
}): Promise<{ submitted: number; refused: number; failed: number }> {
  const send = deps.send ?? sendDisputeEvidence;
  const totals = { submitted: 0, refused: 0, failed: 0 };
  for (const { name, provider } of deps.providers) {
    const submit = provider?.submitDisputeEvidence;
    if (!provider || !submit) continue;
    try {
      const result = await send(deps.db, {
        provider: {
          submitDisputeEvidence: (input) => submit.call(provider, input),
        },
        providerName: name,
        now: deps.now ?? new Date(),
      });
      totals.submitted += result.submitted;
      totals.refused += result.refused;
      totals.failed += result.failed;
    } catch (error) {
      totals.failed += 1;
      deps.log({
        event: 'collect_disputes.evidence_failed',
        provider: name,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return totals;
}
