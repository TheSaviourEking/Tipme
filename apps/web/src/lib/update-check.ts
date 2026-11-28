/**
 * How often the update notice asks `/api/version` by itself (addendum §3.5). A page whose stream
 * is connected needs no timer: every stream `ready` checks instead, and an API deploy drains every
 * stream, so the reconnect's ready finds the new build. A live provider whose stream is not
 * connected (off, down, connecting) keeps today's 5 minutes; a page with no live provider at all
 * (public and signed-out pages, the receipt) checks every 30 minutes. Every page also checks when
 * it becomes visible again.
 */
export function updateCheckEveryMs(s: {
  streams: number;
  connected: number;
}): number | null {
  if (s.streams === 0) return 30 * 60_000;
  if (s.connected > 0) return null;
  return 5 * 60_000;
}

/** A stream `ready` checks only if the last check was at least this long ago. */
export const READY_CHECK_GAP_MS = 60_000;

/** Whether a stream `ready` at `now` checks, given when the last check went out (or never). */
export function readyMayCheck(
  lastCheckAt: number | null,
  now: number,
): boolean {
  return lastCheckAt === null || now - lastCheckAt >= READY_CHECK_GAP_MS;
}
