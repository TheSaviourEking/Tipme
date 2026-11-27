import type { OpsMailProviders } from '@tipme/contracts';

/** Spread over up to 5 s, so every open Providers page doesn't read at the same instant. */
const JITTER_MS = 5000;
/** Browsers fire a longer setTimeout at once (a request loop): a far-off `until` waits this long. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long until the Providers page should read again on its own while the stream covers it: a
 * resting provider turns "trial" when its `until` passes, with no write and so no signal
 * (addendum §3.3). The earliest `until` still in the future, plus `random() * 5000`; null when no
 * provider has one, and never more than a timer can wait. One deadline, not a poll.
 */
export function nextProviderDeadline(
  providers: OpsMailProviders['providers'],
  nowMs: number,
  random: () => number,
): number | null {
  let earliest: number | null = null;
  for (const provider of providers) {
    const until = provider.health?.until;
    if (!until) continue;
    const at = Date.parse(until);
    if (!Number.isFinite(at) || at <= nowMs) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  if (earliest === null) return null;
  return Math.min(earliest - nowMs + random() * JITTER_MS, MAX_TIMER_MS);
}
