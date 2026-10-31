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

/** Events the database outbox publishes (see packages/database operations). */
export const DOMAIN_EVENT_NAMES: ReadonlySet<string> = new Set([
  'tip.succeeded',
  'tip.failed',
  'payout.paid',
  'payout.failed',
  'payout.conflict',
  'provider_event.conflict',
  'payment.unresolved',
  'payment.conflict',
  'payment.mismatch',
  'payment.reversed',
]);

const UUID = /^[0-9a-f-]{36}$/;

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
    /** Record anonymous server-side outcomes (off in production until D-07). */
    analyticsEnabled?: boolean;
    sealing: MailSealing;
    /** Payments are pretend (mock provider): the tip email says so. */
    pretendPayment: boolean;
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
    return outcome === 'opened' ? 'issue_opened' : 'duplicate';
  }
  await mailForDomainEvent(deps.db, deps.sealing, name, data, deps.dedupeKey);
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
