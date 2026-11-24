import { randomUUID } from 'node:crypto';
import {
  checkProviderSplit,
  drainOrder,
  flagUnconnectedMoney,
  purgeSplitChecks,
  SPLIT_CHECK_BATCH,
  splitOwnersDue,
  type Database,
  type PayoutProviderSet,
  type PayoutReader,
  type ProviderReadFailureLog,
} from '@tipme/database';
import { ensureSchedule } from '../ensure-schedule.js';
import { runUnlessRunning, type LockClient } from '../run-lock.js';

/**
 * Per-provider balances, the daily split check (spec §7, P12). Every 15 minutes, up to
 * SPLIT_CHECK_BATCH owners whose last check is a day old are checked, one at a time, so partner reads
 * spread across the day. A run stops before it could pass SPLIT_CHECK_READ_BUDGET partner reads.
 */
export const SPLIT_CHECK_JOB = 'payments.split_check';
const SPLIT_CHECK_INTERVAL_MS = 15 * 60_000;
/** The most partner reads one run makes. */
export const SPLIT_CHECK_READ_BUDGET = 40;
/**
 * Over any run (40 reads, each given up within 10 s by the provider client) and under the interval,
 * so a run lost with its worker costs at most one turn.
 */
export const SPLIT_CHECK_LOCK_TTL_MS = 14 * 60_000;
/** The unconnected-money sweep and the purge run once a day: both read whole tables. */
const DAILY_MS = 24 * 3_600_000;

/** The database operations a run uses; tests pass fakes. */
export interface SplitCheckOps {
  splitOwnersDue: typeof splitOwnersDue;
  checkProviderSplit: typeof checkProviderSplit;
  flagUnconnectedMoney: typeof flagUnconnectedMoney;
  purgeSplitChecks: typeof purgeSplitChecks;
}

const DATABASE_OPS: SplitCheckOps = {
  splitOwnersDue,
  checkProviderSplit,
  flagUnconnectedMoney,
  purgeSplitChecks,
};

export interface SplitCheckSummary {
  checked: number;
  ok: number;
  short: number;
  over: number;
  partial: number;
  /** Owners whose check threw; logged by id, and the run carried on. */
  failed: number;
  /** Partner reads made. */
  reads: number;
  /** Owners were left for the next run because the read budget could be passed. */
  stoppedEarly: boolean;
  /** Issues opened for money at a provider no longer connected; null when not this run's turn. */
  unconnected: number | null;
  /** Check rows purged; null when not this run's turn. */
  purged: number | null;
}

/** Every 15 minutes, with SCHEDULED_RUN_RETENTION (the 21 Nov 2026 rule). */
export function ensureSplitCheckSchedule(
  deps: Pick<Parameters<typeof ensureSchedule>[0], 'queue' | 'logger'>,
): ReturnType<typeof ensureSchedule> {
  return ensureSchedule({
    ...deps,
    id: SPLIT_CHECK_JOB,
    every: SPLIT_CHECK_INTERVAL_MS,
  });
}

/** The same provider, counting each call that reaches the partner. */
function counting(provider: PayoutReader, count: () => void): PayoutReader {
  return {
    name: provider.name,
    ...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
    payoutCapability(accountRef) {
      count();
      return provider.payoutCapability(accountRef);
    },
    payoutBalance(accountRef, currency) {
      count();
      return provider.payoutBalance(accountRef, currency);
    },
    quotePayoutFee(accountRef, amountMinor, currency) {
      count();
      return provider.quotePayoutFee(accountRef, amountMinor, currency);
    },
  };
}

/**
 * One run, behind `runUnlessRunning` so a slow one makes the next skip. `lock` is also where the
 * daily turn of the unconnected-money sweep and the purge is kept (`<lockKey>:daily`, 24 h): the
 * first run of each day does them. A failed read is the check's own outcome (`partial`), never a
 * throw, so the queue never retries a run into more partner reads.
 */
export function runProviderSplitCheck(
  lock: LockClient,
  lockKey: string,
  deps: {
    db: Database;
    providers: PayoutProviderSet;
    now?: Date;
    ops?: SplitCheckOps;
    onReadFailure?: ProviderReadFailureLog;
    /** Staff logs: an owner's check that threw, by the owner's id only. */
    log?: (entry: { event: string; owner: string }) => void;
  },
): Promise<{ ran: true; value: SplitCheckSummary } | { ran: false }> {
  return runUnlessRunning(
    lock,
    { key: lockKey, ttlMs: SPLIT_CHECK_LOCK_TTL_MS },
    async () => {
      const ops = deps.ops ?? DATABASE_OPS;
      const now = deps.now ?? new Date();
      let reads = 0;
      const count = () => {
        reads += 1;
      };
      // Counted on the way to the partner, whatever the check reads.
      const providers: PayoutProviderSet = {
        active: counting(deps.providers.active, count),
        withdrawOnly: deps.providers.withdrawOnly.map((provider) =>
          counting(provider, count),
        ),
      };
      // An owner reads every provider once, and once more when short (the re-read before an issue).
      const mostPerOwner = 2 * drainOrder(providers).length;
      const summary: SplitCheckSummary = {
        checked: 0,
        ok: 0,
        short: 0,
        over: 0,
        partial: 0,
        failed: 0,
        reads: 0,
        stoppedEarly: false,
        unconnected: null,
        purged: null,
      };
      const due = await ops.splitOwnersDue(deps.db, providers, {
        now,
        limit: SPLIT_CHECK_BATCH,
      });
      for (const owner of due) {
        if (reads + mostPerOwner > SPLIT_CHECK_READ_BUDGET) {
          summary.stoppedEarly = true;
          break;
        }
        try {
          const { outcome } = await ops.checkProviderSplit(
            deps.db,
            owner,
            providers,
            {
              now,
              ...(deps.onReadFailure
                ? { onReadFailure: deps.onReadFailure }
                : {}),
            },
          );
          summary.checked += 1;
          summary[outcome] += 1;
        } catch {
          // One owner that always throws must not block the rest, the sweep or the purge. It stays
          // due (no row), so it is tried again next run; the error itself is not logged, as its text
          // could carry anything.
          summary.failed += 1;
          deps.log?.({
            event: 'split_check.owner_failed',
            owner: 'businessId' in owner ? owner.businessId : owner.profileId,
          });
        }
      }
      summary.reads = reads;
      const dailyKey = `${lockKey}:daily`;
      const token = randomUUID();
      if ((await lock.set(dailyKey, token, 'PX', DAILY_MS, 'NX')) === 'OK') {
        try {
          summary.unconnected = await ops.flagUnconnectedMoney(
            deps.db,
            deps.providers,
            now,
          );
          summary.purged = await ops.purgeSplitChecks(deps.db, now);
        } catch (error) {
          // Not done: the next run takes the turn again.
          await lock
            .eval(
              `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
              1,
              dailyKey,
              token,
            )
            .catch(() => undefined);
          throw error;
        }
      }
      return summary;
    },
  );
}
