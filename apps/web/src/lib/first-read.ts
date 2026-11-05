/**
 * A panel's first read while the live stream connects (review I4). The `ready` resync must read
 * every panel anyway (a read whose snapshot came before the stream registered can miss a signal),
 * so reading on mount as well doubled every load. Instead the first read waits for that resync;
 * a slow stream never blanks the page (it reads after 1.5 s), and a stream that is refused, off or
 * polling reads at once. Safe: anything a held read could miss was committed after registration,
 * and so is signalled.
 */
export const FIRST_READ_CAP_MS = 1500;

/**
 * `hold`: a stream is connecting. `connected`: it is ready (its resync reads registered panels).
 * `free`: no stream to wait for (none, off, refused, polling).
 */
export type FirstReadPhase = 'hold' | 'connected' | 'free';

export interface FirstRead {
  update(phase: FirstReadPhase): void;
  /** The panel's reload began, from any cause. */
  started(): void;
  dispose(): void;
}

export function createFirstRead(o: {
  capMs: number;
  read: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}): FirstRead {
  let done = false;
  let held = false;
  let cap: unknown;
  const clearCap = () => {
    if (cap === undefined) return;
    o.clearTimeout(cap);
    cap = undefined;
  };
  const readNow = () => {
    if (done) return;
    done = true;
    clearCap();
    o.read();
  };
  return {
    update(phase) {
      if (done) return;
      if (phase === 'free') return readNow();
      if (phase === 'hold') {
        held = true;
        cap ??= o.setTimeout(readNow, o.capMs);
        return;
      }
      // Connected. Held until now: the ready resync reads this panel (the cap stays as a backstop).
      // Connected from the start: nothing else will read it.
      if (!held) readNow();
    },
    started() {
      done = true;
      clearCap();
    },
    dispose() {
      done = true;
      clearCap();
    },
  };
}

/**
 * Which phase panels are in. With live updates off, or no EventSource, there is nothing to wait for:
 * every panel reads at once, as before the feature. Otherwise a stream that is starting or
 * connecting holds first reads for its ready.
 */
export function firstReadPhase(o: {
  enabled: boolean;
  supported: boolean;
  status: 'idle' | 'connecting' | 'connected' | 'polling' | 'disabled';
}): FirstReadPhase {
  if (!o.enabled || !o.supported) return 'free';
  if (o.status === 'idle' || o.status === 'connecting') return 'hold';
  return o.status === 'connected' ? 'connected' : 'free';
}
