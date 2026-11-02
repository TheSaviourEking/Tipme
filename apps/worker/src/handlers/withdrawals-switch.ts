import { webhookAlert, type PaymentReserveLog } from './payment-reserve.js';

/**
 * Tells staff that all withdrawals were switched, through the reserve alerts' route. A failed post
 * throws, so the job retries. With no route (only allowed while payments are off) it is logged.
 */
export async function handleWithdrawalsSwitchChanged(
  data: unknown,
  deps: {
    url: string | undefined;
    fetchImpl?: typeof fetch;
    log?: PaymentReserveLog;
  },
): Promise<'sent' | 'unrouted'> {
  // Anything but a clear "on" reads as off: the alert errs towards someone looking.
  const paused = (data as { state?: unknown } | null)?.state !== 'on';
  const text = paused
    ? 'Withdrawals were switched OFF for everyone by staff. New withdrawals are refused and queued ones wait. The reason is in the audit log.'
    : 'Withdrawals were switched back ON by staff. Queued ones start now, except any with an issue or a hold since they were requested, which wait for staff. The reason is in the audit log.';
  if (!deps.url) {
    deps.log?.({ event: 'withdrawals.switch_alert_unrouted', text });
    return 'unrouted';
  }
  await webhookAlert({
    url: deps.url,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })(text);
  return 'sent';
}
