'use client';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  LIVE_RECIPIENT_TYPES,
  LIVE_STAFF_TYPES,
  type LiveEventType,
} from '@tipme/contracts';
import {
  createLiveClient,
  type LiveClientDeps,
  type LiveProbe,
  type LiveStatus,
} from '@/lib/live-client';
import {
  createRefetchScheduler,
  withdrawalsSignalDelay,
  type RefetchScheduler,
} from '@/lib/live-refetch';
import { firstReadPhase, type FirstReadPhase } from '@/lib/first-read';
import { apiUrl } from '@/lib/session-client';

interface LiveContextValue {
  scheduler: RefetchScheduler;
  status: LiveStatus;
  /** Whether panels hold their first read for the stream's ready (src/lib/first-read.ts). */
  phase: FirstReadPhase;
  /** Reasons a hidden tab keeps its stream (the armed tip sound). */
  keepers: Set<() => boolean>;
  /** Panels that know of a withdrawal of this person's still on its way. */
  inFlight: Set<() => boolean>;
}

const LiveContext = createContext<LiveContextValue | null>(null);

const PATHS = { me: '/v1/me/events', ops: '/v1/ops/events' } as const;
const PROBE_TIMEOUT_MS = 5000;

/**
 * Why the stream failed. EventSource can't read a status code, so this asks the same URL with
 * fetch and drops the body at once: 204 is "turned off", 401 signed out, 429/503 a refusal.
 */
async function probe(url: string): Promise<LiveProbe> {
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      signal: abort.signal,
      headers: { accept: 'text/event-stream' },
    });
    abort.abort();
    if (response.status === 204) return 'disabled';
    if (response.status === 401) return 'unauthenticated';
    if (response.status === 429 || response.status === 503) return 'refused';
    return response.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * One live connection per tab (spec §6.1). Panels register what to re-read with useLiveEvents;
 * a signal, a resync and the fallback poll all run those same reads. Renders no box of its own:
 * `data-live` on a `display: contents` wrapper says how it is connected (tests read it).
 */
export function LiveProvider({
  stream,
  children,
  keepOpenWhenHidden,
  onSignedOut,
  enabled = true,
}: {
  stream: 'me' | 'ops';
  children: ReactNode;
  /** False until the page knows who is signed in: nothing connects before then. */
  enabled?: boolean;
  keepOpenWhenHidden?: () => boolean;
  onSignedOut?: () => void;
}) {
  const [inFlight] = useState(() => new Set<() => boolean>());
  const [scheduler] = useState(() =>
    createRefetchScheduler({
      debounceMs: 300,
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
      // A broadcast can't be told apart from one's own signal: spread unless one is in flight.
      signalDelay: withdrawalsSignalDelay({
        random: Math.random,
        inFlight: () => [...inFlight].some((known) => known()),
      }),
    }),
  );
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [keepers] = useState(() => new Set<() => boolean>());
  const keepOpen = useRef(keepOpenWhenHidden);
  const signedOut = useRef(onSignedOut);
  useEffect(() => {
    keepOpen.current = keepOpenWhenHidden;
    signedOut.current = onSignedOut;
  });

  useEffect(() => {
    if (!enabled) return;
    // No EventSource: stay 'idle', so the bell keeps its own poll, as today.
    if (typeof window.EventSource !== 'function') return;
    const url = apiUrl(PATHS[stream]);
    const client = createLiveClient({
      url,
      // The DOM's handler types are narrower than the client's EventSourceLike; same object.
      EventSource:
        window.EventSource as unknown as LiveClientDeps['EventSource'],
      now: () => performance.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
      random: Math.random,
      visible: () => document.visibilityState === 'visible',
      probe: () => probe(url),
      keepOpenWhenHidden: () =>
        (keepOpen.current?.() ?? false) || [...keepers].some((keep) => keep()),
    });
    const offs = [
      ...[...LIVE_RECIPIENT_TYPES, ...LIVE_STAFF_TYPES].map((type) =>
        client.on(type, () => scheduler.signal(type)),
      ),
      client.onResync(({ immediate }) =>
        scheduler.resyncAll(immediate ? { delayMs: 0 } : undefined),
      ),
      client.onStatus(setStatus),
      client.onSignedOut(() => signedOut.current?.()),
    ];
    const visibility = () => client.visibilityChanged();
    const online = () => client.online();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', online);
    client.start();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online);
      for (const off of offs) off();
      client.stop();
    };
  }, [stream, scheduler, enabled, keepers]);

  return (
    <LiveContext.Provider
      value={{
        scheduler,
        status,
        keepers,
        inFlight,
        phase: firstReadPhase({
          enabled,
          supported:
            typeof window !== 'undefined' &&
            typeof window.EventSource === 'function',
          status,
        }),
      }}
    >
      <div data-live={status} style={{ display: 'contents' }}>
        {children}
      </div>
    </LiveContext.Provider>
  );
}

/**
 * Re-runs `refetch` on any of `types`, and on every resync and fallback poll. A no-op outside a
 * LiveProvider. `refetch` may change every render; the registration follows the latest one.
 */
export function useLiveEvents(
  types: readonly LiveEventType[],
  refetch: () => Promise<void>,
  options?: { resync?: boolean },
): void {
  const resync = options?.resync ?? true;
  const scheduler = useContext(LiveContext)?.scheduler;
  const latest = useRef(refetch);
  useEffect(() => {
    latest.current = refetch;
  });
  const key = types.join(',');
  useEffect(() => {
    if (!scheduler) return;
    return scheduler.register(
      key ? (key.split(',') as LiveEventType[]) : [],
      () => latest.current(),
      { resync },
    );
  }, [scheduler, key, resync]);
}

/** 'idle' outside a provider. */
export function useLiveStatus(): LiveStatus {
  return useContext(LiveContext)?.status ?? 'idle';
}

/** While `keep()` is true, a hidden tab keeps its stream open past 5 minutes. */
export function useKeepStreamOpenWhenHidden(keep: () => boolean): void {
  const keepers = useContext(LiveContext)?.keepers;
  const latest = useRef(keep);
  useEffect(() => {
    latest.current = keep;
  });
  useEffect(() => {
    if (!keepers) return;
    const entry = () => latest.current();
    keepers.add(entry);
    return () => {
      keepers.delete(entry);
    };
  }, [keepers]);
}

/** 'free' outside a provider: nothing to wait for. */
export function useFirstReadPhase(): FirstReadPhase {
  return useContext(LiveContext)?.phase ?? 'free';
}

/**
 * While `known()` is true, this person has a withdrawal on its way, so a `withdrawals.changed` is
 * re-read at once instead of after a random 0-10 s (live-refetch.ts, withdrawalsSignalDelay).
 */
export function useWithdrawalInFlight(known: () => boolean): void {
  const registry = useContext(LiveContext)?.inFlight;
  const latest = useRef(known);
  useEffect(() => {
    latest.current = known;
  });
  useEffect(() => {
    if (!registry) return;
    const entry = () => latest.current();
    registry.add(entry);
    return () => {
      registry.delete(entry);
    };
  }, [registry]);
}
