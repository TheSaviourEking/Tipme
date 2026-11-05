import type {
  LiveBrowserMessage,
  LiveEventType,
  LiveMessage,
} from '@tipme/contracts';

/**
 * The hub's routing core: pure, with injected timers, so every rule is unit-tested
 * (apps/api/test/live-hub.test.mjs). It routes only by ids the server resolved from the cookie, and
 * it writes only `{ type }` to a browser: the routing key never leaves the server.
 */

export type LiveCloseReason =
  'client' | 'lifetime' | 'session_ended' | 'draining' | 'error';

export interface LiveSink {
  id: string;
  kind: 'me' | 'ops';
  userId: string;
  profileId: string | null;
  /** Ops streams only. */
  permissions: ReadonlySet<string> | null;
  /** Already-framed SSE text. */
  write(frame: string): void;
  close(reason: LiveCloseReason): void;
  /** False: the session or grant is gone. */
  recheck(): Promise<boolean>;
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: 'limit_user' | 'limit_process' | 'draining' };

export interface LiveRouterOptions {
  maxPerUser: number;
  maxStreams: number;
  coalesceMs: number;
  random: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onDelivered?: (type: string) => void;
}

export interface LiveRouter {
  register(sink: LiveSink): RegisterResult;
  unregister(id: string): void;
  dispatch(message: LiveMessage): void;
  broadcastControl(type: 'resync' | 'poll'): void;
  /** A jittered retry, then close every stream; refuse new ones from now on. */
  drain(): void;
  readonly draining: boolean;
  counts(): { me: number; ops: number };
}

export const sseFrame = (m: LiveBrowserMessage): string =>
  `data: ${JSON.stringify({ type: m.type })}\n\n`;
export const sseRetry = (ms: number): string => `retry: ${ms}\n\n`;

const DRAIN_RETRY_MIN_MS = 1000;
const DRAIN_RETRY_MAX_MS = 10_000;

interface Window {
  timer: unknown;
  /** Types that arrived in the window, repeats included: written once at its end. */
  pending: Set<LiveEventType>;
}

export function createLiveRouter(o: LiveRouterOptions): LiveRouter {
  const byId = new Map<string, LiveSink>();
  const byUser = new Map<string, Set<LiveSink>>();
  const byProfile = new Map<string, Set<LiveSink>>();
  const ops = new Set<LiveSink>();
  const windows = new Map<string, Window>();
  let draining = false;
  let meCount = 0;

  const add = (map: Map<string, Set<LiveSink>>, key: string, s: LiveSink) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(s);
  };
  const remove = (
    map: Map<string, Set<LiveSink>>,
    key: string,
    s: LiveSink,
  ) => {
    const set = map.get(key);
    if (!set) return;
    set.delete(s);
    if (set.size === 0) map.delete(key);
  };

  function detach(id: string): LiveSink | undefined {
    const s = byId.get(id);
    if (!s) return undefined;
    byId.delete(id);
    remove(byUser, s.userId, s);
    if (s.profileId) remove(byProfile, s.profileId, s);
    if (s.kind === 'ops') ops.delete(s);
    else meCount -= 1;
    const w = windows.get(id);
    if (w) {
      o.clearTimer(w.timer);
      windows.delete(id);
    }
    return s;
  }

  function deliver(s: LiveSink, type: LiveEventType): void {
    s.write(sseFrame({ type }));
    o.onDelivered?.(type);
  }

  /*
   * The first signal writes at once and opens a 250 ms window. Anything that arrives in the window,
   * a repeat included, is written once at its end: a repeat is never dropped, because the browser
   * may already have a read under way that started before the change it announces. A flush opens
   * the next window, so a stream gets at most one frame per type per window.
   */
  function openWindow(s: LiveSink): void {
    const w: Window = { pending: new Set(), timer: undefined };
    w.timer = o.setTimer(() => {
      windows.delete(s.id);
      if (!byId.has(s.id) || w.pending.size === 0) return;
      const flushed = [...w.pending];
      for (const t of flushed) deliver(s, t);
      openWindow(s);
    }, o.coalesceMs);
    windows.set(s.id, w);
  }

  function send(s: LiveSink, type: LiveEventType): void {
    const open = windows.get(s.id);
    if (open) {
      open.pending.add(type);
      return;
    }
    deliver(s, type);
    openWindow(s);
  }

  function end(s: LiveSink): void {
    if (!detach(s.id)) return;
    s.write(sseFrame({ type: 'session.ended' }));
    s.close('session_ended');
  }

  function recheckAll(sinks: Iterable<LiveSink>): void {
    for (const s of [...sinks]) {
      void s.recheck().then(
        (ok) => {
          if (!ok) end(s);
        },
        () => end(s),
      );
    }
  }

  function targets(message: LiveMessage): LiveSink[] {
    const to = message.to;
    if ('user' in to)
      return [...(byUser.get(to.user) ?? [])].filter((s) => s.kind === 'me');
    if ('profile' in to)
      return [...(byProfile.get(to.profile) ?? [])].filter(
        (s) => s.kind === 'me',
      );
    if ('all' in to) return [...byId.values()].filter((s) => s.kind === 'me');
    if (to.staff === 'any') return [...ops];
    return [...ops].filter((s) => s.permissions?.has(to.staff) === true);
  }

  return {
    register(s) {
      if (draining) return { ok: false, reason: 'draining' };
      if (byId.size >= o.maxStreams)
        return { ok: false, reason: 'limit_process' };
      if ((byUser.get(s.userId)?.size ?? 0) >= o.maxPerUser)
        return { ok: false, reason: 'limit_user' };
      byId.set(s.id, s);
      add(byUser, s.userId, s);
      if (s.profileId) add(byProfile, s.profileId, s);
      if (s.kind === 'ops') ops.add(s);
      else meCount += 1;
      return { ok: true };
    },
    unregister(id) {
      detach(id);
    },
    dispatch(message) {
      if (message.type === 'sessions.changed') {
        if ('user' in message.to) recheckAll(byUser.get(message.to.user) ?? []);
        return;
      }
      if (message.type === 'staff.changed') {
        recheckAll(ops);
        return;
      }
      for (const s of targets(message)) send(s, message.type);
    },
    broadcastControl(type) {
      const frame = sseFrame({ type });
      for (const s of byId.values()) s.write(frame);
    },
    drain() {
      draining = true;
      for (const s of [...byId.values()]) {
        detach(s.id);
        const ms =
          DRAIN_RETRY_MIN_MS +
          Math.floor(
            o.random() * (DRAIN_RETRY_MAX_MS - DRAIN_RETRY_MIN_MS + 1),
          );
        s.write(sseRetry(Math.min(ms, DRAIN_RETRY_MAX_MS)));
        s.close('draining');
      }
    },
    get draining() {
      return draining;
    },
    counts() {
      return { me: meCount, ops: ops.size };
    },
  };
}
