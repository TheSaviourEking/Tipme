import type { LiveEventType } from '@tipme/contracts';

/**
 * Debounced, single-flight refetches for live signals (spec §6.1). Pure, with injected timers.
 * A registration's refetch runs once for every signal burst inside `debounceMs`, measured from the
 * first signal: never two at once, and a signal during a run gives exactly one more after it. The
 * hub never drops a signal: repeats inside its 250 ms window get one frame at the window's end, so
 * a read that began before a change is always followed by one after it.
 */
export interface RefetchScheduler {
  /** `resync: false`: only its signals run it (a "New tips" button, not a re-read). */
  register(
    types: readonly LiveEventType[],
    refetch: () => Promise<void>,
    options?: { resync?: boolean },
  ): () => void;
  /** Debounced per registration. */
  signal(type: LiveEventType): void;
  /**
   * Every registration, debounced (ready, resync, poll ticks, safety, visible). `delayMs` replaces
   * the debounce: 0 for the page's first ready, which is its panels' first read.
   */
  resyncAll(o?: { delayMs?: number }): void;
}

interface Registration {
  types: ReadonlySet<string>;
  resync: boolean;
  refetch: () => Promise<void>;
  timer: unknown;
  running: boolean;
  again: boolean;
  gone: boolean;
}

export function createRefetchScheduler(o: {
  debounceMs: number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}): RefetchScheduler {
  const registrations = new Set<Registration>();

  const run = (r: Registration): void => {
    if (r.gone) return;
    if (r.running) {
      r.again = true;
      return;
    }
    r.running = true;
    void r
      .refetch()
      .catch(() => undefined)
      .finally(() => {
        r.running = false;
        if (r.again && !r.gone) {
          r.again = false;
          run(r);
        }
      });
  };

  const schedule = (r: Registration, delayMs = o.debounceMs): void => {
    if (r.gone || r.timer !== undefined) return;
    r.timer = o.setTimeout(() => {
      r.timer = undefined;
      run(r);
    }, delayMs);
  };

  return {
    register(types, refetch, options) {
      const r: Registration = {
        types: new Set(types),
        resync: options?.resync ?? true,
        refetch,
        timer: undefined,
        running: false,
        again: false,
        gone: false,
      };
      registrations.add(r);
      return () => {
        r.gone = true;
        if (r.timer !== undefined) o.clearTimeout(r.timer);
        r.timer = undefined;
        registrations.delete(r);
      };
    },
    signal(type) {
      for (const r of registrations) if (r.types.has(type)) schedule(r);
    },
    resyncAll(options) {
      for (const r of registrations)
        if (r.resync) schedule(r, options?.delayMs);
    },
  };
}
