import { createHash } from 'node:crypto';
import type {
  CollectReconReader,
  CollectReserveReader,
  Database,
  MailSealing,
} from '@tipme/database';
import {
  checkCollectReserve,
  mailOwnersCollectReserve,
  purgeCollectReserveRows,
  reconcileCollect,
  RESERVE_KEEP_MS,
} from '@tipme/database';
import { webhookAlert } from './payment-reserve.js';

/*
 * You collect (plan Task 11, spec §6.3 and §7). With each reserve check (every 15 minutes, after
 * today's NGN payout-fee check), TipMe's own money is checked against what it holds for recipients
 * per currency; and once a day (02:00 Lagos) the partner's transfers and disputes, and TipMe's own
 * balance activity, are reconciled with our records. Both only read the partner, and a failure is a
 * logged outcome, never a throw, so the queue doesn't retry it into more partner calls.
 */

export type CollectJobLog = (entry: {
  event: string;
  error?: string;
  checked?: number;
  mismatches?: number;
  unreadable?: number;
  currencies?: number;
  levels?: string;
}) => void;

/** The adapter calls the reserve check needs, or null when this provider has none of them. */
export function collectReserveReader(provider: {
  name: string;
  platformBalances?: CollectReserveReader['platformBalances'];
  platformPayoutSchedule?: CollectReserveReader['platformPayoutSchedule'];
}): CollectReserveReader | null {
  const { platformBalances, platformPayoutSchedule } = provider;
  if (!platformBalances || !platformPayoutSchedule) return null;
  return {
    name: provider.name,
    platformBalances: () => platformBalances.call(provider),
    platformPayoutSchedule: () => platformPayoutSchedule.call(provider),
  };
}

export async function handleCollectReserve(deps: {
  db: Database;
  provider: CollectReserveReader;
  alertWebhookUrl: string | undefined;
  sealing: MailSealing;
  log: CollectJobLog;
  now?: Date;
  /** Replaced in tests. */
  check?: typeof checkCollectReserve;
  mailOwners?: typeof mailOwnersCollectReserve;
  purge?: typeof purgeCollectReserveRows;
}): Promise<'checked' | 'failed'> {
  const now = deps.now ?? new Date();
  const post = webhookAlert({
    url: deps.alertWebhookUrl,
    log: deps.log,
    unroutedEvent: 'collect_reserve.alert_unrouted',
  });
  try {
    const result = await (deps.check ?? checkCollectReserve)(deps.db, {
      provider: deps.provider,
      // A critical alert pages: it says so first, so the alert route can route it.
      alert: (text, level) =>
        post(level === 'critical' ? `CRITICAL: ${text}` : text),
      emailOwners: async (text) => {
        // One email per owner per alert text and Lagos day, however often the check repeats it.
        const day = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Africa/Lagos',
        }).format(now);
        const spell = createHash('sha256')
          .update(`${day}\n${text}`)
          .digest('hex')
          .slice(0, 32);
        await (deps.mailOwners ?? mailOwnersCollectReserve)(
          deps.db,
          deps.sealing,
          { alert: text, spell },
        );
      },
      now,
    });
    deps.log({
      event: 'collect_reserve.checked',
      currencies: result.perCurrency.length,
      levels: result.perCurrency
        .map((c) => `${c.currency}:${c.level}`)
        .join(','),
      ...(result.unreadable ? { error: 'unreadable' } : {}),
    });
    // Housekeeping after the check, never in its way (m9).
    await (deps.purge ?? purgeCollectReserveRows)(deps.db, {
      before: new Date(now.getTime() - RESERVE_KEEP_MS),
    }).catch(() => deps.log({ event: 'collect_reserve.purge_failed' }));
    return 'checked';
  } catch (error) {
    deps.log({
      event: 'collect_reserve.failed',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return 'failed';
  }
}

/** The adapter calls reconciliation needs, or null when this provider has none of them. */
export function collectReconReader(provider: {
  name: string;
  listAccountTransfers?: CollectReconReader['listAccountTransfers'];
  listDisputes?: (
    since: Date,
  ) => ReturnType<CollectReconReader['listDisputes']>;
}): CollectReconReader | null {
  const { listAccountTransfers, listDisputes } = provider;
  if (!listAccountTransfers || !listDisputes) return null;
  return {
    name: provider.name,
    listAccountTransfers: (ref) => listAccountTransfers.call(provider, ref),
    listDisputes: (since) => listDisputes.call(provider, since),
  };
}

/** The daily run: its totals are logged every time (spec §7). */
export async function handleCollectRecon(deps: {
  db: Database;
  provider: CollectReconReader;
  log: CollectJobLog;
  day?: Date;
  /** Replaced in tests. */
  recon?: typeof reconcileCollect;
}): Promise<'reconciled' | 'failed'> {
  try {
    const totals = await (deps.recon ?? reconcileCollect)(deps.db, {
      provider: deps.provider,
      day: deps.day ?? new Date(),
    });
    deps.log({ event: 'collect_recon.completed', ...totals });
    return 'reconciled';
  } catch (error) {
    deps.log({
      event: 'collect_recon.failed',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return 'failed';
  }
}
