import { SERIOUS_ACTION_WORDS } from '@tipme/contracts';
import type { Database, MailSealing } from '@tipme/database';
import {
  evaluateTipMoments,
  ISSUE_EVENT_NAMES,
  mailForDomainEvent,
  notifyTipSucceeded,
  openIssueFromEvent,
  recordServerEvent,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { webhookAlert } from './payment-reserve.js';

/** Events the database outbox publishes (see packages/database operations). */
export const DOMAIN_EVENT_NAMES: ReadonlySet<string> = new Set([
  'tip.succeeded',
  'tip.failed',
  'payout.paid',
  'payout.failed',
  'payout.conflict',
  'ops.acted_alone',
  'ops.approval_pending',
  'ops.last_approver_removed',
  'ops.approval_ran',
  'ops.approval_closed',
  'ops.staff_changed',
  'ops.freeze_released',
  'provider_event.conflict',
  'payment.unresolved',
  'payment.conflict',
  'payment.mismatch',
  'payment.reversed',
  'username.take_back_done',
  // Paid Pro (ADR-0015): money alerts that become inbox issues.
  'pro.amount_mismatch',
  'pro.late_payment',
  'pro.conflict',
  'pro.reversed',
  'pro.collect_unknown',
  'pro.refund_failed',
]);

const UUID = /^[0-9a-f-]{36}$/;

const STAFF_ALERT_EVENTS: ReadonlySet<string> = new Set([
  'ops.acted_alone',
  'ops.approval_pending',
  'ops.last_approver_removed',
]);

/** Staff alerts that open no inbox issue: the post is all there is, besides any mail. */
const POSTED_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'username.take_back_done',
  'ops.approval_ran',
  'ops.approval_closed',
  'ops.staff_changed',
  'ops.freeze_released',
]);

export interface StaffAlert {
  event: string;
  action: string;
  requestedBy: string;
}

/**
 * The staff alert on the webhook route (spec 6.4). An event can be delivered again, and the inbox and
 * mail steps dedupe but a post won't, so it may repeat; it holds names and ids only.
 */
export type PostStaffAlert = (alert: StaffAlert) => Promise<void>;

/**
 * Posts through the webhook alert route. A failure doesn't retry the event, as the inbox and mail
 * already have it: it logs the route's fixed message, which never holds the address.
 */
export function staffAlertPoster(options: {
  url: string | undefined;
  fetchImpl?: typeof fetch;
  log: (entry: { event: string; error?: string }) => void;
}): PostStaffAlert {
  const post = webhookAlert({
    url: options.url,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    log: ({ event }) => options.log({ event }),
    unroutedEvent: 'staff_alert.unrouted',
  });
  return async ({ event, action, requestedBy }) => {
    try {
      await post(`TipMe staff alert: ${event}: ${action} (by ${requestedBy})`);
    } catch (error) {
      options.log({
        event: 'staff_alert.not_posted',
        error: error instanceof Error ? error.message : 'alert_route_failed',
      });
    }
  };
}

/**
 * A verified tip notifies its recipient (in-app, and by email when verified); repeats of the same
 * event are no-ops. Every other event is acknowledged in the logs by name only (payloads stay out
 * of logs) so delivery and tracing can be verified.
 */
export async function handleDomainEvent(
  name: string,
  data: unknown,
  deps: {
    db: Database;
    logger: Logger;
    rewardBudgetPerMonthMinor?: bigint;
    /** The outbox dedupe key (the job id). */
    dedupeKey?: string;
    /** Record anonymous server-side outcomes (on unless ANALYTICS_ENABLED=false; D-07 open). */
    analyticsEnabled?: boolean;
    sealing: MailSealing;
    /** Payments are pretend (mock provider): the tip email says so. */
    pretendPayment: boolean;
    postStaffAlert?: PostStaffAlert;
  },
): Promise<'logged' | 'notified' | 'duplicate' | 'skipped' | 'issue_opened'> {
  deps.logger.info({ event: 'domain_event.received', name });
  // Alerts that need a person become issues in the admin inbox, once per alert (PR-009).
  if (ISSUE_EVENT_NAMES.has(name) && deps.dedupeKey) {
    const outcome = await openIssueFromEvent(deps.db, {
      eventType: name,
      dedupeKey: deps.dedupeKey,
      payload: data,
    });
    // After the issue, so staff always see it; a failed email retries the event, and both
    // steps are no-ops the second time.
    await mailForDomainEvent(deps.db, deps.sealing, name, data, deps.dedupeKey);
    if (STAFF_ALERT_EVENTS.has(name) && deps.postStaffAlert) {
      const fields = (data ?? {}) as Record<string, unknown>;
      const { requestedBy } = fields;
      // Losing the last second person is about permissions, not one action.
      const action = fields['action'] ?? fields['permissions'];
      await deps.postStaffAlert({
        event: name,
        action: typeof action === 'string' ? action : 'unknown',
        requestedBy: typeof requestedBy === 'string' ? requestedBy : 'unknown',
      });
    }
    return outcome === 'opened' ? 'issue_opened' : 'duplicate';
  }
  await mailForDomainEvent(deps.db, deps.sealing, name, data, deps.dedupeKey);
  if (POSTED_ONLY_EVENTS.has(name) && deps.postStaffAlert) {
    const { action, outcome, requestedBy, targetId, roleName } = (data ??
      {}) as Record<string, unknown>;
    // A take-back's alert names the action in words: the inbox has no issue for it.
    const what =
      name === 'username.take_back_done' && action === 'username.take_back'
        ? SERIOUS_ACTION_WORDS['username.take_back']
        : typeof action === 'string'
          ? action
          : 'unknown';
    const about =
      typeof targetId === 'string'
        ? `${what}: ${targetId}${typeof roleName === 'string' ? `, ${roleName}` : ''}`
        : what;
    await deps.postStaffAlert({
      event: name,
      action: typeof outcome === 'string' ? `${about}: ${outcome}` : about,
      requestedBy: typeof requestedBy === 'string' ? requestedBy : 'unknown',
    });
  }
  if (name === 'tip.failed' && deps.analyticsEnabled) {
    const { tipId, profileId } = (data ?? {}) as Record<string, unknown>;
    if (typeof tipId === 'string' && UUID.test(tipId))
      await recordServerEvent(deps.db, {
        name: 'payment_failed',
        dedupeKey: `payment_failed.${tipId}`,
        profileId:
          typeof profileId === 'string' && UUID.test(profileId)
            ? profileId
            : undefined,
      });
    return 'logged';
  }
  if (name === 'payout.paid' && deps.analyticsEnabled) {
    // A withdrawal the provider confirmed as paid (PRD v1.1 §11 payout_paid_verified).
    const { payoutId, profileId } = (data ?? {}) as Record<string, unknown>;
    if (
      typeof payoutId === 'string' &&
      UUID.test(payoutId) &&
      typeof profileId === 'string' &&
      UUID.test(profileId)
    )
      // Analytics never fails the work that caused it: logged by name, not retried.
      await recordServerEvent(deps.db, {
        name: 'payout_paid_verified',
        dedupeKey: `payout_paid_verified.${payoutId}`,
        profileId,
      }).catch(() =>
        deps.logger.warn({
          event: 'analytics.server_event_failed',
          name: 'payout_paid_verified',
        }),
      );
    return 'logged';
  }
  if (name !== 'tip.succeeded') return 'logged';
  const { tipId, profileId } = (data ?? {}) as {
    tipId?: unknown;
    profileId?: unknown;
  };
  if (
    typeof tipId !== 'string' ||
    typeof profileId !== 'string' ||
    !UUID.test(tipId) ||
    !UUID.test(profileId)
  )
    return 'skipped';
  const outcome = await notifyTipSucceeded(deps.db, {
    sealing: deps.sealing,
    tipId,
    profileId,
    pretendPayment: deps.pretendPayment,
  });
  if (deps.analyticsEnabled) {
    await recordServerEvent(deps.db, {
      name: 'tip_completed',
      dedupeKey: `tip_completed.${tipId}`,
      profileId,
    });
    // Once per page, ever: the first tip a recipient receives.
    await recordServerEvent(deps.db, {
      name: 'recipient_first_tip',
      dedupeKey: `recipient_first_tip.${profileId}`,
      profileId,
    });
  }
  // Milestones and lovely notes; each moment exists once, so a repeated event changes nothing.
  await evaluateTipMoments(deps.db, {
    profileId,
    tipId,
    now: new Date(),
    budgetPerMonthMinor: deps.rewardBudgetPerMonthMinor ?? 25_000_000n,
    sealing: deps.sealing,
  });
  return outcome === 'created' ? 'notified' : outcome;
}
