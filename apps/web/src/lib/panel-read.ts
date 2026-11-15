import { apiFetch, type SessionResult } from './session-client.ts';

/**
 * How long a dashboard panel waits for a read before treating it as a dropped connection (UI audit,
 * 15 Nov 2026, item 4). Without a limit, a read that never answers keeps the skeleton up forever,
 * with no error and no Try again. Generous, for slow mobile networks: a read rarely takes more than a
 * second or two, and a quiet retry of a busy API (session-client) fits well inside it.
 */
export const PANEL_READ_TIMEOUT_MS = 15_000;

/** One panel read. Never throws, and always settles: an answer, a failure, or the time limit. */
export function readPanel<T>(
  path: string,
  { timeoutMs = PANEL_READ_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<SessionResult<T>> {
  return apiFetch<T>(path, { timeoutMs });
}
