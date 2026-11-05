import type { LiveEventType } from '@tipme/contracts';

/**
 * Debounced, single-flight refetches for live signals (spec §6.1). Pure, with injected timers.
 * A registration's refetch runs once for every signal burst inside `debounceMs`, measured from the
 * first signal: never two at once, and a signal during a run gives exactly one more after it. The
 * hub drops repeats inside 250 ms on the server; this window is longer, so a read started here still
 * sees anything committed before the hub's last dropped repeat.
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
  /** Every registration, debounced (ready, resync, poll ticks, safety, visible). */
  resyncAll(): void;
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

  const schedule = (r: Registration): void => {
    if (r.gone || r.timer !== undefined) return;
    r.timer = o.setTimeout(() => {
      r.timer = undefined;
      run(r);
    }, o.debounceMs);
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
    resyncAll() {
      for (const r of registrations) if (r.resync) schedule(r);
    },
  };
}
