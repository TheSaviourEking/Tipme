// The web's one answer to "can a supporter pay here, and is it real money?", from the API's
// /health/release. test: the pretend provider or Bachs sandbox. closed: Bachs live with live
// payments still switched off. live: Bachs live, switched on. Anything unreadable is closed, so
// a page never shows a pay button or claims "test mode" on a guess.
export type PaymentMode = 'test' | 'closed' | 'live';

export function paymentMode(release: unknown): PaymentMode {
  if (typeof release !== 'object' || release === null) return 'closed';
  const { paymentProvider, paymentsLive } = release as Record<string, unknown>;
  if (paymentProvider === 'mock' || paymentProvider === 'bachs-sandbox')
    return 'test';
  if (paymentProvider === 'bachs-live')
    return paymentsLive === true ? 'live' : 'closed';
  return 'closed';
}
