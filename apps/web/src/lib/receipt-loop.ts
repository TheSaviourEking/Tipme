import type { LiveStatus } from './live-client.ts';
import { GIVE_UP_AFTER_MS, nextCheckDelay } from './status-polling.ts';

/** What one status read found, as far as the loop cares. */
export type ReceiptRead =
  | { kind: 'ok'; final: boolean; live: boolean }
  | { kind: 'not_found' }
  /** No answer (offline, 5xx): try again. */
  | { kind: 'failed' };

export interface ReceiptLoopDeps {
  /** One status read; the page shows what it found. */
  read(): Promise<ReceiptRead>;
  /** The receipt's stream (tip-live.ts followTip). */
  follow(o: { onChange: () => void; onStatus: (s: LiveStatus) => void }): {
    stop(): void;
  };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  /** Date.now(): the round's elapsed time, as nextCheckDelay counts it. */
  now(): number;
  /** The stream's status ('idle' without one). */
  onLive(status: LiveStatus): void;
  /** The round gave up after 15 minutes: the page offers "Check again". */
  onGiveUp(): void;
}

/**
 * One round of the receipt's status checks (addendum §3.6), framework-free so every rule is
 * unit-tested (apps/web/test/receipt-loop.test.mjs). Today's nextCheckDelay loop runs whenever the
 * stream is not connected; while it is, nothing is timed after a read that answered, and the
 * stream says when to read. A read that got no answer is retried on nextCheckDelay even while
 * connected: the stream will not signal the same change again. The stream is followed only when
 * an answer says live updates are on, so with them off the requests and timers are today's.
 */
export function startReceiptLoop(deps: ReceiptLoopDeps): {
  stop(): void;
  /** The browser is back online: check at once. */
  reconnected(): void;
} {
  const started = deps.now();
  let timer: unknown;
  let stopped = false;
  /** Reads finished this round: nextCheckDelay's attempt count. */
  let reads = 0;
  let inFlight = false;
  /** A signal came during a read, which may have started before the change: read once more. */
  let again = false;
  /** Final, not found, or given up: no more reads this round. */
  let done = false;
  let followed = false;
  let follower: { stop(): void } | null = null;
  /** The current follower's identity, so a stopped one's late callbacks are ignored. */
  let current: object | null = null;
  let connected = false;
  /** The last read got no answer: retry it on nextCheckDelay, even while connected. */
  let failed = false;
  let deadline: unknown;

  const clearTimer = () => {
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = undefined;
  };
  const stopFollowing = () => {
    const stopping = follower;
    follower = null;
    current = null;
    connected = false;
    stopping?.stop();
    deps.onLive('idle');
  };
  const finish = () => {
    done = true;
    clearTimer();
    if (deadline !== undefined) deps.clearTimeout(deadline);
    deadline = undefined;
    stopFollowing();
  };
  const schedule = () => {
    if (done || stopped || inFlight || timer !== undefined) return;
    // Connected, the stream says when to read; a read that got no answer is the exception, since
    // the stream will not signal the same change again.
    if (connected && !failed) return;
    const delay = nextCheckDelay(Math.max(0, reads - 1), deps.now() - started);
    if (delay === null) {
      finish();
      deps.onGiveUp();
      return;
    }
    timer = deps.setTimeout(() => {
      timer = undefined;
      void read();
    }, delay);
  };
  const follow = () => {
    const self = {};
    current = self;
    // The round's end, as nextCheckDelay's: the stream stops too, and a connected receipt (no
    // timer of its own) then gives up; a polling one ends on its next check, as today.
    deadline = deps.setTimeout(
      () => {
        deadline = undefined;
        if (done) return;
        stopFollowing();
        schedule();
      },
      Math.max(0, started + GIVE_UP_AFTER_MS - deps.now()),
    );
    follower = deps.follow({
      onChange: () => {
        if (current === self) void read();
      },
      onStatus: (status) => {
        if (current !== self) return;
        deps.onLive(status);
        connected = status === 'connected';
        // A pending retry stays armed: a stream that connects reads on its ready anyway.
        if (connected && !failed) clearTimer();
        else schedule();
      },
    });
  };
  const read = async () => {
    if (done || stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    clearTimer();
    inFlight = true;
    const result = await deps.read();
    inFlight = false;
    if (stopped) return;
    reads += 1;
    failed = result.kind === 'failed';
    if (result.kind === 'ok') {
      if (result.final) {
        finish();
        return;
      }
      if (!followed && result.live) {
        followed = true;
        follow();
      }
    } else if (result.kind === 'not_found') {
      finish();
      return;
    }
    if (again) {
      again = false;
      void read();
      return;
    }
    schedule();
  };
  void read();
  return {
    stop() {
      stopped = true;
      clearTimer();
      if (deadline !== undefined) deps.clearTimeout(deadline);
      deadline = undefined;
      stopFollowing();
    },
    reconnected() {
      // A connected receipt has no timer, and a signal may have been lost while offline.
      if (done || stopped || (timer === undefined && !connected)) return;
      clearTimer();
      void read();
    },
  };
}
