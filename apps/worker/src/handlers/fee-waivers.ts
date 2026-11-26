import {
  runFeeWaiverNotices,
  type Database,
  type FeeWaiverNoticesResult,
} from '@tipme/database';
import { ensureSchedule } from '../ensure-schedule.js';

/**
 * Fee waivers (spec 2026-11-23 §5, §6; W13, W14): the `fees.waivers` job, every 15 minutes. It tells
 * accounts when TipMe starts or stops paying a fee, tells staff the day before a waiver ends, and
 * keeps the low-balance pause issue. Each is once by the database's own records, so a duplicated or
 * overlapping run tells nothing twice; the run lock only saves the work.
 */
export const FEE_WAIVERS_JOB = 'fees.waivers';
const FEE_WAIVERS_INTERVAL_MS = 15 * 60_000;
/** Over any run (a few indexed reads and up to a few hundred small writes) and under the interval. */
export const FEE_WAIVERS_LOCK_TTL_MS = 10 * 60_000;

/** The spec's words for the staff alert (§5). */
export const FEE_WAIVERS_PAUSED_ALERT =
  "Fee waivers paused: TipMe's balance is low";

/** Every 15 minutes, with SCHEDULED_RUN_RETENTION (the 21 Nov 2026 rule). */
export function ensureFeeWaiversSchedule(
  deps: Pick<Parameters<typeof ensureSchedule>[0], 'queue' | 'logger'>,
): ReturnType<typeof ensureSchedule> {
  return ensureSchedule({
    ...deps,
    id: FEE_WAIVERS_JOB,
    every: FEE_WAIVERS_INTERVAL_MS,
  });
}

const ALERT_ERROR = /^alert_route_[a-z0-9_]{1,40}$/;

/**
 * One run. The webhook is posted only when this run opened a spell's issue (W14), so a spell is
 * alerted once. An alert that fails is logged, not thrown: the issue is already open in the inbox,
 * and a retried run would find it there and post nothing.
 */
export async function handleFeeWaivers(deps: {
  db: Database;
  /** `PAYMENT_PROVIDER`: whose balance readings pause tip waivers. */
  activeProvider: string;
  alert: (text: string) => Promise<void>;
  now?: Date;
  log?: (entry: { event: string; error: string }) => void;
  /** For tests: the run itself has its own integration tests. */
  run?: typeof runFeeWaiverNotices;
}): Promise<FeeWaiverNoticesResult> {
  const result = await (deps.run ?? runFeeWaiverNotices)(deps.db, {
    activeProvider: deps.activeProvider,
    now: deps.now ?? new Date(),
  });
  if (result.paused === 'opened')
    try {
      await deps.alert(FEE_WAIVERS_PAUSED_ALERT);
    } catch (error) {
      // webhookAlert's own fixed messages only: anything else could quote the route.
      const message = error instanceof Error ? error.message : '';
      deps.log?.({
        event: 'fee_waivers.alert_failed',
        error: ALERT_ERROR.test(message) ? message : 'unknown',
      });
    }
  return result;
}
