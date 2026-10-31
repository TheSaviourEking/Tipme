const SECOND = 1000;
const MINUTE = 60 * SECOND;
const GIVE_UP_AFTER_MS = 15 * MINUTE;

/**
 * When the receipt checks the tip's status again: every second for the first ten checks, then
 * 2 s, 5 s after half a minute, and every 15 s from two minutes, since a provider can take a few
 * minutes to confirm. Null after 15 minutes: the page then offers "Try again".
 */
export function nextCheckDelay(
  attempt: number,
  elapsedMs: number,
): number | null {
  if (elapsedMs >= GIVE_UP_AFTER_MS) return null;
  if (attempt < 10) return SECOND;
  if (elapsedMs < 30 * SECOND) return 2 * SECOND;
  if (elapsedMs < 2 * MINUTE) return 5 * SECOND;
  return 15 * SECOND;
}
