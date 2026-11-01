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

/**
 * Live payments can be limited to named pages, so "live" alone doesn't say this page takes tips.
 * Real money needs the API's yes for this page: anything else shows the closed state, the same as a
 * closed copy, and checkout refuses it on the server regardless.
 */
export function profileTippingClosed(
  mode: PaymentMode,
  profile: { tippingOpen?: boolean },
): boolean {
  if (mode === 'test') return false;
  return mode === 'closed' || profile.tippingOpen !== true;
}

/**
 * Reads the mode at most once a minute while the API answers. A failed read (a build or cold
 * start with no API, an outage) is closed and kept for a few seconds only, so it is never
 * served for long; reads at the same moment share one request.
 */
export function createPaymentModeReader({
  read,
  now,
  okMs = 60_000,
  failedMs = 5_000,
}: {
  read: () => Promise<unknown>;
  now: () => number;
  okMs?: number;
  failedMs?: number;
}): () => Promise<PaymentMode> {
  let kept: { mode: PaymentMode; until: number } | null = null;
  let pending: Promise<PaymentMode> | null = null;
  return () => {
    if (kept && now() < kept.until) return Promise.resolve(kept.mode);
    pending ??= read()
      .then(
        (release) => ({ mode: paymentMode(release), ms: okMs }),
        () => ({ mode: 'closed' as const, ms: failedMs }),
      )
      .then(({ mode, ms }) => {
        kept = { mode, until: now() + ms };
        pending = null;
        return mode;
      });
    return pending;
  };
}
