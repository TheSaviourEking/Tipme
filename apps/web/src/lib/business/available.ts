// Whether this copy of TipMe has businesses switched on, from the API's public /health/release
// (`business`, BUSINESS_ENABLED). Anything unreadable is off: the visitor then sees the
// coming-soon interest form, never a "Create your business" that leads to a 404.
export function businessAvailable(release: unknown): boolean {
  return (
    typeof release === 'object' &&
    release !== null &&
    (release as { business?: unknown }).business === true
  );
}

/**
 * Reads the answer at most once a minute while the API answers. A failed read (a build with no
 * API, an outage) is off and kept for a few seconds only; reads at the same moment share one
 * request. The same shape as the payment mode's reader.
 */
export function createBusinessReader({
  read,
  now,
  okMs = 60_000,
  failedMs = 5_000,
}: {
  read: () => Promise<unknown>;
  now: () => number;
  okMs?: number;
  failedMs?: number;
}): () => Promise<boolean> {
  let kept: { on: boolean; until: number } | null = null;
  let pending: Promise<boolean> | null = null;
  return () => {
    if (kept && now() < kept.until) return Promise.resolve(kept.on);
    pending ??= read()
      .then(
        (release) => ({ on: businessAvailable(release), ms: okMs }),
        () => ({ on: false, ms: failedMs }),
      )
      .then(({ on, ms }) => {
        kept = { on, until: now() + ms };
        pending = null;
        return on;
      });
    return pending;
  };
}
