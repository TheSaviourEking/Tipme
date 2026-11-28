import { GIVE_UP_AFTER_MS, nextCheckDelay } from './status-polling.ts';

/** What one read of the purchase found, as far as the loop cares. */
export type ProConfirmRead =
  /** Paid, failed, expired, in review, or not found: the slip has its answer. */
  | 'done'
  /** Still PENDING, COLLECTING or UNKNOWN. */
  | 'open'
  /** No answer (offline, 5xx): try again. */
  | 'failed';

export interface ProConfirmLoopDeps {
  /** One read of the purchase; the slip shows what it found. */
  read(): Promise<ProConfirmRead>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  /** Date.now(): the round's elapsed time, as nextCheckDelay counts it. */
  now(): number;
  /** Whether the dashboard stream is connected when the round starts. */
  connected: boolean;
  /** 15 minutes without an answer: the slip offers "Check again". */
  onGiveUp(): void;
}

/**
 * One round of Settings' "confirming" checks (addendum §3.7), framework-free so every rule is
 * unit-tested (apps/web/test/pro-confirm-loop.test.mjs). Not connected: today's nextCheckDelay
 * loop, exactly. Connected: nothing is timed after a read that answered; `signal()` (pro.changed,
 * profile.changed, every resync) says when to read. A read that got no answer is retried on
 * nextCheckDelay even while connected, since the stream will not signal the same change again.
 * The 15-minute give-up stays: while connected a deadline timer stands in for the check that would
 * have found the time was up. It is armed only while connected, so with live updates off the
 * timers are today's.
 */
export function startProConfirmLoop(deps: ProConfirmLoopDeps): {
  /** A signal or resync: read now (once more after a read already running). */
  signal(): Promise<void>;
  /** The dashboard stream's status changed. */
  setConnected(connected: boolean): void;
  stop(): void;
} {
  const started = deps.now();
  let connected = deps.connected;
  let timer: unknown;
  let deadline: unknown;
  /** Reads finished this round: nextCheckDelay's attempt count. */
  let reads = 0;
  let running: Promise<void> | null = null;
  /** A signal came during a read, which may have started before the change: read once more. */
  let again = false;
  /** The last read got no answer: retry it on nextCheckDelay, even while connected. */
  let failed = false;
  /** Answered, given up or stopped: no more reads this round. */
  let done = false;

  const clearTimer = () => {
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = undefined;
  };
  const clearDeadline = () => {
    if (deadline !== undefined) deps.clearTimeout(deadline);
    deadline = undefined;
  };
  const finish = () => {
    done = true;
    clearTimer();
    clearDeadline();
  };
  const schedule = () => {
    if (done || running || timer !== undefined) return;
    const delay = nextCheckDelay(Math.max(0, reads - 1), deps.now() - started);
    if (delay === null) {
      finish();
      deps.onGiveUp();
      return;
    }
    if (connected && !failed) return;
    timer = deps.setTimeout(() => {
      timer = undefined;
      void read();
    }, delay);
  };
  const armDeadline = () => {
    if (done || deadline !== undefined) return;
    deadline = deps.setTimeout(
      () => {
        deadline = undefined;
        schedule();
      },
      Math.max(0, started + GIVE_UP_AFTER_MS - deps.now()),
    );
  };
  const read = (): Promise<void> => {
    if (done) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    clearTimer();
    running = (async () => {
      const result = await deps.read();
      running = null;
      if (done) return;
      reads += 1;
      failed = result === 'failed';
      if (result === 'done') {
        finish();
        return;
      }
      if (again) {
        again = false;
        await read();
        return;
      }
      schedule();
    })();
    return running;
  };

  if (connected) armDeadline();
  void read();
  return {
    signal: read,
    setConnected(next) {
      if (done || next === connected) return;
      connected = next;
      if (connected) {
        armDeadline();
        // A pending retry of a failed read stays armed.
        if (!failed) clearTimer();
      } else {
        clearDeadline();
        schedule();
      }
    },
    stop: finish,
  };
}
