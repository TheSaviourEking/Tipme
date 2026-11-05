import {
  LIVE_RECIPIENT_TYPES,
  LIVE_STAFF_TYPES,
  type LiveEventType,
} from '@tipme/contracts';

/**
 * The browser's live connection (spec §6), framework-free so every rule is unit-tested
 * (apps/web/test/live-client.test.mjs). It never shows data: a signal only tells the page which of
 * its existing reads to repeat, and every (re)connect resyncs instead of replaying.
 */

export type LiveStatus =
  'idle' | 'connecting' | 'connected' | 'polling' | 'disabled';

/** Why the stream failed, asked of the server (EventSource can't read a status code). */
export type LiveProbe =
  'ok' | 'disabled' | 'unauthenticated' | 'refused' | 'error';

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

export interface LiveClientDeps {
  url: string;
  EventSource: new (
    url: string,
    init: { withCredentials: boolean },
  ) => EventSourceLike;
  /** performance.now(): never the wall clock. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  random(): number;
  visible(): boolean;
  probe(): Promise<LiveProbe>;
  /** The armed tip sound (plan note 3): a hidden tab keeps its stream while this is true. */
  keepOpenWhenHidden(): boolean;
}

export interface LiveClient {
  start(): void;
  stop(): void;
  on(type: LiveEventType, fn: () => void): () => void;
  /** ready, resync (after 0–5 s), poll ticks, safety, visible, online. */
  onResync(fn: () => void): () => void;
  onStatus(fn: (status: LiveStatus) => void): () => void;
  onSignedOut(fn: () => void): () => void;
  visibilityChanged(): void;
  online(): void;
  readonly status: LiveStatus;
}

export const LIVE_TIMING = {
  watchdogMs: 50_000,
  readyTimeoutMs: 10_000,
  bufferedRetryMs: 300_000,
  pollMs: 20_000,
  pollJitterMs: 2_000,
  streamRetryWhilePollingMs: 60_000,
  hiddenCloseMs: 300_000,
  safetyMs: 300_000,
  backoffCapMs: 60_000,
  resyncJitterMs: 5_000,
} as const;

const CLOSED = 2;
const KNOWN: ReadonlySet<string> = new Set([
  ...LIVE_RECIPIENT_TYPES,
  ...LIVE_STAFF_TYPES,
]);

/** Full jitter: a random wait below 1, 2, 4 … 60 s for attempt 1, 2, 3 …. */
export function backoffDelay(attempt: number, random: () => number): number {
  const cap = Math.min(
    LIVE_TIMING.backoffCapMs,
    1000 * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(random() * cap);
}

type TimerName =
  | 'reconnect'
  | 'watchdog'
  | 'ready'
  | 'poll'
  | 'streamRetry'
  | 'hidden'
  | 'safety'
  | 'resync';

export function createLiveClient(deps: LiveClientDeps): LiveClient {
  const signalListeners = new Map<string, Set<() => void>>();
  const resyncListeners = new Set<() => void>();
  const statusListeners = new Set<(status: LiveStatus) => void>();
  const signedOutListeners = new Set<() => void>();
  const timers = new Map<TimerName, unknown>();

  let status: LiveStatus = 'idle';
  let running = false;
  let source: EventSourceLike | null = null;
  let opened = false;
  let failures = 0;
  /** Degraded: refetch every 20 s while visible. */
  let polling = false;
  /** The stream was closed because the tab was hidden; reopen when it is visible. */
  let sleeping = false;
  let ready = false;

  const later = (name: TimerName, fn: () => void, ms: number) => {
    clear(name);
    timers.set(
      name,
      deps.setTimeout(
        () => {
          timers.delete(name);
          fn();
        },
        Math.max(0, ms),
      ),
    );
  };
  const clear = (name: TimerName) => {
    if (!timers.has(name)) return;
    deps.clearTimeout(timers.get(name));
    timers.delete(name);
  };
  const clearAll = () => {
    for (const name of [...timers.keys()]) clear(name);
  };

  const setStatus = (next: LiveStatus) => {
    if (next === status) return;
    status = next;
    for (const fn of statusListeners) fn(next);
  };
  const statusNow = () =>
    setStatus(polling ? 'polling' : ready ? 'connected' : 'connecting');

  const resync = () => {
    for (const fn of [...resyncListeners]) fn();
  };

  const closeSource = () => {
    clear('watchdog');
    clear('ready');
    clear('safety');
    if (!source) return;
    const s = source;
    source = null;
    s.onopen = s.onmessage = s.onerror = null;
    s.close();
    ready = false;
  };

  const armWatchdog = () => {
    later(
      'watchdog',
      () => {
        // A sleeping laptop's socket is often dead without an error: start again.
        closeSource();
        connect();
      },
      LIVE_TIMING.watchdogMs,
    );
  };

  const armSafety = () => {
    later(
      'safety',
      () => {
        if (ready && !polling && deps.visible()) resync();
        armSafety();
      },
      LIVE_TIMING.safetyMs,
    );
  };

  const schedulePoll = () => {
    if (!polling || !deps.visible()) return;
    const jitter = (deps.random() * 2 - 1) * LIVE_TIMING.pollJitterMs;
    later(
      'poll',
      () => {
        resync();
        schedulePoll();
      },
      LIVE_TIMING.pollMs + jitter,
    );
  };

  const startPolling = () => {
    if (!polling) {
      polling = true;
      schedulePoll();
    }
    statusNow();
  };
  const stopPolling = () => {
    polling = false;
    clear('poll');
    clear('streamRetry');
  };

  /** Try the stream again later while polling covers the page. */
  const retryStreamIn = (ms: number) =>
    later(
      'streamRetry',
      () => {
        if (!source) connect();
      },
      ms,
    );

  const end = (signedOut: boolean) => {
    running = false;
    closeSource();
    stopPolling();
    clearAll();
    setStatus('idle');
    if (signedOut) for (const fn of [...signedOutListeners]) fn();
  };

  const disable = () => {
    running = false;
    closeSource();
    stopPolling();
    clearAll();
    setStatus('disabled');
  };

  const afterProbe = async (): Promise<'handled' | 'retry'> => {
    let answer: LiveProbe;
    try {
      answer = await deps.probe();
    } catch {
      answer = 'error';
    }
    if (!running) return 'handled';
    if (answer === 'unauthenticated') {
      end(true);
      return 'handled';
    }
    if (answer === 'disabled') {
      disable();
      return 'handled';
    }
    if (answer === 'refused') {
      // 429 or 503: this copy is full or stopping, or too many tabs are open.
      startPolling();
      retryStreamIn(LIVE_TIMING.streamRetryWhilePollingMs);
      return 'handled';
    }
    return 'retry';
  };

  const failed = async (refusedBeforeOpen: boolean) => {
    closeSource();
    failures += 1;
    if (refusedBeforeOpen || failures >= 2) {
      if ((await afterProbe()) === 'handled') return;
    }
    if (!running) return;
    if (failures >= 3) {
      startPolling();
      retryStreamIn(LIVE_TIMING.streamRetryWhilePollingMs);
      return;
    }
    statusNow();
    later('reconnect', connect, backoffDelay(failures, deps.random));
  };

  const onMessage = (raw: unknown) => {
    armWatchdog();
    let type: unknown;
    try {
      type = (JSON.parse(String(raw)) as { type?: unknown }).type;
    } catch {
      return;
    }
    if (typeof type !== 'string') return;
    switch (type) {
      case 'ready':
        clear('ready');
        failures = 0;
        ready = true;
        stopPolling();
        statusNow();
        armSafety();
        resync();
        return;
      case 'resync':
        // Every tab heard the same "back" at once: spread the refetches.
        later(
          'resync',
          () => {
            stopPolling();
            statusNow();
            resync();
          },
          deps.random() * LIVE_TIMING.resyncJitterMs,
        );
        return;
      case 'poll':
        // This API copy can't hear signals: keep the stream, poll until it says resync.
        startPolling();
        return;
      case 'session.ended':
        closeSource();
        void afterProbe().then((outcome) => {
          if (outcome === 'retry' && running) connect();
        });
        return;
      default:
        if (!KNOWN.has(type)) return;
        for (const fn of [...(signalListeners.get(type) ?? [])]) fn();
    }
  };

  function connect(): void {
    if (!running) return;
    clear('reconnect');
    clear('streamRetry');
    closeSource();
    sleeping = false;
    opened = false;
    const s = new deps.EventSource(deps.url, { withCredentials: true });
    source = s;
    statusNow();
    s.onopen = () => {
      opened = true;
      armWatchdog();
      later(
        'ready',
        () => {
          // Open but nothing arrives: a proxy is buffering. Poll, and try again much later.
          closeSource();
          startPolling();
          retryStreamIn(LIVE_TIMING.bufferedRetryMs);
        },
        LIVE_TIMING.readyTimeoutMs,
      );
    };
    s.onmessage = (event) => onMessage(event.data);
    s.addEventListener('hb', () => {
      if (source === s) armWatchdog();
    });
    s.onerror = () => {
      if (source !== s) return;
      // Closed before it ever opened: the server refused (204, 401, 429, 503). The client
      // always closes it itself, so the browser's own retry never runs.
      void failed(!opened && s.readyState === CLOSED);
    };
  }

  const armHidden = () =>
    later(
      'hidden',
      () => {
        if (deps.visible()) return;
        if (deps.keepOpenWhenHidden()) {
          armHidden();
          return;
        }
        closeSource();
        sleeping = true;
      },
      LIVE_TIMING.hiddenCloseMs,
    );

  return {
    start() {
      if (running || status === 'disabled') return;
      running = true;
      failures = 0;
      connect();
    },
    stop() {
      end(false);
    },
    on(type, fn) {
      let set = signalListeners.get(type);
      if (!set) signalListeners.set(type, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    onResync(fn) {
      resyncListeners.add(fn);
      return () => resyncListeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    onSignedOut(fn) {
      signedOutListeners.add(fn);
      return () => signedOutListeners.delete(fn);
    },
    visibilityChanged() {
      if (!running) return;
      if (!deps.visible()) {
        clear('poll');
        armHidden();
        return;
      }
      clear('hidden');
      if (sleeping) {
        // The stream was closed for being hidden: reconnecting resyncs on ready.
        connect();
        schedulePoll();
        return;
      }
      if (!source && polling) {
        // Degraded: refresh once now, then keep polling while the stream is retried.
        resync();
        schedulePoll();
        return;
      }
      resync();
      schedulePoll();
    },
    online() {
      if (!running) return;
      failures = 0;
      connect();
      if (polling) resync();
    },
    get status() {
      return status;
    },
  };
}
