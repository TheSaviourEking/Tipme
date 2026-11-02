import { webhookAlert, type PaymentReserveLog } from './payment-reserve.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Tells staff a takeover report opened a new issue, through the reserve alerts' route. A failed post
 * throws, so the job retries. With no route (only allowed while payments are off) it is logged.
 */
export async function handleWithdrawalFreezeOpened(
  data: unknown,
  deps: {
    url: string | undefined;
    fetchImpl?: typeof fetch;
    log?: PaymentReserveLog;
  },
): Promise<'sent' | 'unrouted'> {
  const issueId = (data as { issueId?: unknown } | null)?.issueId;
  const issue =
    typeof issueId === 'string' && UUID.test(issueId)
      ? `issue ${issueId}`
      : 'a new issue';
  const text = `An account takeover was reported, and that page's withdrawals are frozen until staff close ${issue} as secured. Work it in the issues inbox. The reason is in the audit log.`;
  if (!deps.url) {
    deps.log?.({ event: 'withdrawals.freeze_alert_unrouted', text });
    return 'unrouted';
  }
  await webhookAlert({
    url: deps.url,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })(text);
  return 'sent';
}
