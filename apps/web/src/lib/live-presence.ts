import type { LiveStatus } from './live-client';

export type LivePresenceEvent = 'status' | 'ready';

/** What a live provider reports for as long as it is mounted. */
export interface LivePresenceMember {
  status(s: LiveStatus): void;
  ready(): void;
  leave(): void;
}

/**
 * The page's live streams as the update notice sees them (addendum §3.5): the `me` and `ops`
 * providers join on mount and report their status and each `ready`. In-page only, no request.
 */
export interface LivePresence {
  join(): LivePresenceMember;
  /** `status` when a count may have changed (join, leave, a new status); `ready` on each ready. */
  subscribe(fn: (event: LivePresenceEvent) => void): () => void;
  snapshot(): { streams: number; connected: number };
}

export function createLivePresence(): LivePresence {
  const members = new Map<symbol, LiveStatus>();
  const listeners = new Set<(event: LivePresenceEvent) => void>();
  const tell = (event: LivePresenceEvent) => {
    for (const fn of [...listeners]) fn(event);
  };
  return {
    join() {
      const id = Symbol('live-provider');
      members.set(id, 'idle');
      tell('status');
      // A member that left ignores late callbacks: a stopped client must not count again.
      return {
        status(s) {
          if (!members.has(id) || members.get(id) === s) return;
          members.set(id, s);
          tell('status');
        },
        ready() {
          if (members.has(id)) tell('ready');
        },
        leave() {
          if (members.delete(id)) tell('status');
        },
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    snapshot() {
      let connected = 0;
      for (const s of members.values()) if (s === 'connected') connected += 1;
      return { streams: members.size, connected };
    },
  };
}

/** The page's one registry: every provider and the update notice share it. */
export const livePresence = createLivePresence();
