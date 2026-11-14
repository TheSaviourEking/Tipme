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

export interface ReleaseFlags {
  business: boolean;
  /** Business Pro (Phases A to C); the API reports it once Phase A ships. */
  businessPro: boolean;
  /** Business sign-up: the fork, a business with no page, the switcher (Phase D). */
  businessSignup: boolean;
  /** Co-owners and handover (Phase E). */
  businessOwners: boolean;
}

/**
 * The business flags from /health/release. Each later flag is on only on top of `business`, and
 * only an explicit `true` counts: an older API that doesn't send one reads as off.
 */
export function releaseFlags(release: unknown): ReleaseFlags {
  const business = businessAvailable(release);
  const on = (key: keyof ReleaseFlags) =>
    business && (release as Record<string, unknown>)[key] === true;
  return {
    business,
    businessPro: on('businessPro'),
    businessSignup: on('businessSignup'),
    businessOwners: on('businessOwners'),
  };
}

/**
 * Reads the answer at most once a minute while the API answers. A failed read (a build with no
 * API, an outage) is all off and kept for a few seconds only; reads at the same moment share one
 * request. The same shape as the payment mode's reader.
 */
export function createReleaseFlagsReader({
  read,
  now,
  okMs = 60_000,
  failedMs = 5_000,
}: {
  read: () => Promise<unknown>;
  now: () => number;
  okMs?: number;
  failedMs?: number;
}): () => Promise<ReleaseFlags> {
  let kept: { flags: ReleaseFlags; until: number } | null = null;
  let pending: Promise<ReleaseFlags> | null = null;
  return () => {
    if (kept && now() < kept.until) return Promise.resolve(kept.flags);
    pending ??= read()
      .then(
        (release) => ({ flags: releaseFlags(release), ms: okMs }),
        () => ({ flags: releaseFlags(null), ms: failedMs }),
      )
      .then(({ flags, ms }) => {
        kept = { flags, until: now() + ms };
        pending = null;
        return flags;
      });
    return pending;
  };
}

/** Whether businesses are on, from the same reader. */
export function createBusinessReader(
  options: Parameters<typeof createReleaseFlagsReader>[0],
): () => Promise<boolean> {
  const read = createReleaseFlagsReader(options);
  return () => read().then((flags) => flags.business);
}
