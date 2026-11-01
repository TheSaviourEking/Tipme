import { connection } from 'next/server';
import { API_ORIGIN } from './profiles-api';
import { createPaymentModeReader, type PaymentMode } from './payment-mode';

const readMode = createPaymentModeReader({
  read: async () => {
    const response = await fetch(`${API_ORIGIN}/health/release`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new Error(`release lookup failed: ${response.status}`);
    return ((await response.json()) as { data?: unknown }).data;
  },
  now: Date.now,
});

/**
 * This copy's payment mode, from the API's public /health/release (open past the preview gate).
 * Read at request time only (never at build, where there is no API to ask), so callers render
 * it inside a Suspense boundary (PaymentModeSlot). Each web instance asks the API at most once a
 * minute; a failed read is closed and retried after a few seconds.
 */
export async function getPaymentMode(): Promise<PaymentMode> {
  await connection();
  return readMode();
}
