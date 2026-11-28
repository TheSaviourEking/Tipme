import type { LiveStatus } from './live-client';

/**
 * Whether a screen runs its own refresh timer: only when no live connection covers it — no
 * provider or no EventSource ('idle'), or live updates turned off ('disabled'). While the stream
 * connects, is connected, or polls in its place ('polling'), the stream's reads are the screen's.
 */
export function ownTimerRuns(status: LiveStatus): boolean {
  return status === 'idle' || status === 'disabled';
}
