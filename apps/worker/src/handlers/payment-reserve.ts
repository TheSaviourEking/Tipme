import type { Database, ReserveReader } from '@tipme/database';
import {
  checkReserve,
  purgeReserveReadings,
  requeuePayoutsWaitingOnPlatform,
  RESERVE_KEEP_MS,
} from '@tipme/database';

const ALERT_TIMEOUT_MS = 10_000;

export type PaymentReserveOutcome = 'ok' | 'low' | 'unreadable';

export type PaymentReserveLog = (entry: {
  event: string;
  text?: string;
  setting?: string;
}) => void;

/** One warning when reserve checks run with nowhere to send an alert. Names the setting only. */
export function warnIfNoAlertRoute(
  url: string | undefined,
  log: PaymentReserveLog,
): void {
  if (!url)
    log({ event: 'reserve.no_alert_route', setting: 'ALERT_WEBHOOK_URL' });
}

/**
 * Posts alert text to the alert route as {"text": ...} (Slack-compatible), the same shape the
 * watchers use. Without a route the text goes to the log but the alert is refused, so it is not
 * counted as sent: the 6-hour timer is not spent, and the first alert goes out as soon as an
 * address is set. A failure throws a fixed message: the address is a credential and an HTTP
 * client's error can quote it, so nothing from the failure is kept.
 */
export function webhookAlert(options: {
  url: string | undefined;
  fetchImpl?: typeof fetch;
  log?: PaymentReserveLog;
}): (text: string) => Promise<void> {
  const { url, fetchImpl = fetch, log } = options;
  return async (text) => {
    if (!url) {
      log?.({ event: 'reserve.alert_unrouted', text });
      throw new Error('alert_route_missing');
    }
    let status: number;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        // A redirect would send the text somewhere the route did not name.
        redirect: 'error',
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      status = response.status;
    } catch {
      throw new Error('alert_route_unreachable');
    }
    if (status < 200 || status >= 300)
      throw new Error(`alert_route_refused_${status}`);
  };
}

/**
 * One reserve check: reads the platform balance, records it, and tells staff when it is low or
 * unreadable (once, then every 6 hours). Overlap is stopped by the caller. A failed read or alert
 * is a normal outcome, never a throw, so the queue does not retry it into more provider calls.
 */
export async function handlePaymentReserve(deps: {
  db: Database;
  provider: ReserveReader;
  thresholdMinor: bigint;
  alertWebhookUrl: string | undefined;
  log: PaymentReserveLog;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Queues again what waits on the platform. Replaced in tests. */
  requeue?: typeof requeuePayoutsWaitingOnPlatform;
}): Promise<PaymentReserveOutcome> {
  const result = await checkReserve(deps.db, {
    provider: deps.provider,
    thresholdMinor: deps.thresholdMinor,
    alert: webhookAlert({
      url: deps.alertWebhookUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      log: deps.log,
    }),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (result.alertFailed) deps.log({ event: 'reserve.alert_failed' });
  // Funded, as read just now. Every 15 minutes while any still wait; the jobs are safe to repeat.
  if (result.low === false)
    await (deps.requeue ?? requeuePayoutsWaitingOnPlatform)(deps.db).catch(() =>
      deps.log({ event: 'reserve.requeue_failed' }),
    );
  // Housekeeping after the check, never in its way: old readings are not needed for the 6-hour rule.
  await purgeReserveReadings(deps.db, {
    before: new Date((deps.now ?? new Date()).getTime() - RESERVE_KEEP_MS),
  }).catch(() => deps.log({ event: 'reserve.purge_failed' }));
  return result.low === null ? 'unreadable' : result.low ? 'low' : 'ok';
}
