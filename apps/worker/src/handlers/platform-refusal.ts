import { webhookAlert, type PaymentReserveLog } from './payment-reserve.js';

/**
 * Tells staff the provider refused TipMe itself, through the reserve alerts' route. A failed post
 * throws, so the job retries. With no route (only allowed while payments are off) it is logged.
 */
export async function handlePlatformRefusal(
  data: unknown,
  deps: {
    url: string | undefined;
    fetchImpl?: typeof fetch;
    log?: PaymentReserveLog;
  },
): Promise<'sent' | 'unrouted'> {
  const cause = (data as { cause?: unknown } | null)?.cause;
  const text =
    cause === 'provider_key'
      ? 'The payment provider refused TipMe’s API key. Withdrawals are waiting and nothing was sent. Check the key and its permissions; see the issues inbox.'
      : 'The payment reserve could not cover a payout fee. Withdrawals are waiting and nothing failed. Top up the reserve; they start again once a reading is at the alert level.';
  if (!deps.url) {
    deps.log?.({ event: 'payouts.platform_refusal_unrouted', text });
    return 'unrouted';
  }
  await webhookAlert({
    url: deps.url,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })(text);
  return 'sent';
}
