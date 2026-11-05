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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function profileOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const id = (payload as { profileId?: unknown }).profileId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

type Mapping = (payload: unknown) => LiveMessage[];
const none: Mapping = () => [];
const toProfile =
  (type: LiveMessage['type']): Mapping =>
  (payload) => {
    const profile = profileOf(payload);
    return profile ? [{ to: { profile }, type }] : [];
  };

/**
 * Every event the relay puts on the queue, each mapped explicitly, so a new event type fails the
 * unit test until someone decides its signal. `none` until PR 2 (withdrawals, freeze, switch) and
 * PR 3 (staff) extend it.
 */
const OUTBOX_SIGNALS: Readonly<Record<string, Mapping>> = {
  // Written with the tip, attempt and ledger in one transaction (provider-events.ts).
  'tip.succeeded': toProfile('tips.changed'),
  'tip.failed': toProfile('tips.changed'),
  'payout.paid': none,
  'payout.failed': none,
  'payout.conflict': none,
  'ops.acted_alone': none,
  'ops.approval_pending': none,
  'ops.last_approver_removed': none,
  'ops.approval_ran': none,
  'ops.approval_closed': none,
  'ops.staff_changed': none,
  'ops.freeze_released': none,
  'provider_event.conflict': none,
  'payment.unresolved': none,
  'payment.conflict': none,
  'payment.mismatch': none,
  'payment.reversed': none,
  [PAYOUT_START_EVENT]: none,
  [PLATFORM_REFUSAL_EVENT]: none,
  [WITHDRAWAL_FREEZE_OPENED_EVENT]: none,
  [WITHDRAWALS_SWITCH_EVENT]: none,
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

/** After a job handler returned: the writes it committed itself (notifications, moments). */
export function jobSignalsFor(
  jobName: string,
  outcome: string,
  data: unknown,
): LiveMessage[] {
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
