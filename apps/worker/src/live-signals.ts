import {
  PAYOUT_START_EVENT,
  PLATFORM_REFUSAL_EVENT,
  WITHDRAWAL_FREEZE_OPENED_EVENT,
  WITHDRAWALS_SWITCH_EVENT,
  type LiveMessage,
} from '@tipme/contracts';

/**
 * Which live signals a committed change raises (spec §4). Pure: unknown or malformed payloads give
 * []. Signals name what changed, never data: the browser re-reads its authorised endpoints.
 */

/** The job names job-worker.ts uses for these sweeps. */
export const PAYOUT_SETUP_JOB_NAME = 'payment-accounts.payout-setup';
export const WEEKLY_REPORTS_JOB_NAME = 'reports.weekly';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function profileOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const id = (payload as { profileId?: unknown }).profileId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

type Mapping = (payload: unknown) => LiveMessage[];
const none: Mapping = () => [];
const toAll =
  (type: LiveMessage['type']): Mapping =>
  () => [{ to: { all: true }, type }];
const toProfile =
  (type: LiveMessage['type']): Mapping =>
  (payload) => {
    const profile = profileOf(payload);
    return profile ? [{ to: { profile }, type }] : [];
  };

/**
 * Every event the relay puts on the queue, each mapped explicitly, so a new event type fails the
 * unit test until someone decides its signal. Staff events stay `none` until PR 3.
 */
const OUTBOX_SIGNALS: Readonly<Record<string, Mapping>> = {
  // Written with the tip, attempt and ledger in one transaction (provider-events.ts).
  'tip.succeeded': toProfile('tips.changed'),
  'tip.failed': toProfile('tips.changed'),
  // Written with the payout's outcome (payouts.ts): its status, and the balance when it failed.
  'payout.paid': toProfile('withdrawals.changed'),
  'payout.failed': toProfile('withdrawals.changed'),
  'payout.conflict': none,
  'ops.acted_alone': none,
  'ops.approval_pending': none,
  'ops.last_approver_removed': none,
  'ops.approval_ran': none,
  'ops.approval_closed': none,
  'ops.staff_changed': none,
  // The issue's page: `profileId` was added to this payload for live updates (issues.ts).
  'ops.freeze_released': toProfile('withdrawals.changed'),
  'provider_event.conflict': none,
  'payment.unresolved': none,
  'payment.conflict': none,
  'payment.mismatch': none,
  'payment.reversed': none,
  // Nothing has changed yet when it is queued: the job worker signals after the start ran.
  [PAYOUT_START_EVENT]: none,
  [PLATFORM_REFUSAL_EVENT]: none,
  [WITHDRAWAL_FREEZE_OPENED_EVENT]: toProfile('withdrawals.changed'),
  // TipMe-wide: every open dashboard re-reads, each after its own random wait (live-refetch.ts).
  [WITHDRAWALS_SWITCH_EVENT]: toAll('withdrawals.changed'),
};

export const LIVE_SIGNAL_MAPPED_EVENTS: ReadonlySet<string> = new Set(
  Object.keys(OUTBOX_SIGNALS),
);

/** Outbox event → signals, published by the relay after its claim commits. */
export function liveSignalFor(
  eventType: string,
  payload: unknown,
): LiveMessage[] {
  return (OUTBOX_SIGNALS[eventType] ?? none)(payload);
}

/** A payout start that moved the payout (sent, refused or left uncertain); the rest changed nothing. */
const PAYOUT_START_CHANGED: ReadonlySet<string> = new Set([
  'started',
  'failed',
  'uncertain',
]);

/** Valid profile ids from a job's result; anything else is dropped. */
function profilesOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const ids = (data as { profileIds?: unknown }).profileIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter(
    (id): id is string => typeof id === 'string' && UUID.test(id),
  );
}

/**
 * After a job handler returned: the writes it committed itself. `data` is the job's payload, or for
 * the sweeps (payout setup, weekly reports) `{ profileIds }` from the result, never logged.
 */
export function jobSignalsFor(
  jobName: string,
  outcome: string,
  data: unknown,
): LiveMessage[] {
  if (jobName === PAYOUT_START_EVENT)
    return PAYOUT_START_CHANGED.has(outcome)
      ? toProfile('withdrawals.changed')(data)
      : [];
  if (jobName === PAYOUT_SETUP_JOB_NAME && outcome === 'swept')
    return profilesOf(data).map((profile) => ({
      to: { profile },
      type: 'payments.changed' as const,
    }));
  if (jobName === WEEKLY_REPORTS_JOB_NAME && outcome === 'reported')
    return profilesOf(data).flatMap((profile) => [
      { to: { profile }, type: 'reports.changed' as const },
      { to: { profile }, type: 'notifications.changed' as const },
    ]);
  if (
    jobName === 'tip.succeeded' &&
    (outcome === 'notified' || outcome === 'duplicate')
  ) {
    const profile = profileOf(data);
    if (!profile) return [];
    return [
      { to: { profile }, type: 'notifications.changed' },
      { to: { profile }, type: 'moments.changed' },
    ];
  }
  return [];
}
