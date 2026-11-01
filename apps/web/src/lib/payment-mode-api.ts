import { cacheLife } from 'next/cache';
import { API_ORIGIN } from './profiles-api';
import { paymentMode, type PaymentMode } from './payment-mode';

/**
 * This copy's payment mode, from the API's public /health/release (open past the preview gate).
 * Shared by every page for a minute, so pages never ask the API per request. A failure is
 * cached as 'closed' on purpose: a failed lookup that escaped the cache would leave a
 * prerendered page with no cache life, frozen at 'closed' until the next deploy.
 */
export async function getPaymentMode(): Promise<PaymentMode> {
  'use cache';
  cacheLife({ stale: 60, revalidate: 60, expire: 300 });
  try {
    const response = await fetch(`${API_ORIGIN}/health/release`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return 'closed';
    const body = (await response.json()) as { data?: unknown };
    return paymentMode(body.data);
  } catch {
    return 'closed';
  }
}
