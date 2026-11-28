import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startReceiptLoop } from '../src/lib/receipt-loop.ts';

const flush = async () => {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function fakeTimers() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const t = { fn, at: now + ms };
      timers.add(t);
      return t;
    },
    clearTimeout(t) {
      timers.delete(t);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter((t) => t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
        await flush();
      }
      now = end;
    },
  };
}

const OPEN = { kind: 'ok', final: false, live: true };
const OPEN_OFF = { kind: 'ok', final: false, live: false };
const PAID = { kind: 'ok', final: true, live: true };
const FAILED = { kind: 'failed' };

/**
 * A loop whose reads answer from `answers` in turn (the last one repeats), and whose stream the
 * test drives through `stream.status(...)` and `stream.change()`.
 */
function harness(answers) {
  const timers = fakeTimers();
  const reads = [];
  const queue = [...answers];
  const stream = { followed: 0, stopped: 0, onChange: null, onStatus: null };
  const live = [];
  let gaveUp = 0;
  const loop = startReceiptLoop({
    read: async () => {
      reads.push(timers.now());
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    follow: ({ onChange, onStatus }) => {
      stream.followed += 1;
      stream.onChange = onChange;
      stream.onStatus = onStatus;
      onStatus('connecting');
      return { stop: () => (stream.stopped += 1) };
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    onLive: (s) => live.push(s),
    onGiveUp: () => (gaveUp += 1),
  });
  return {
    timers,
    reads,
    queue,
    stream,
    live,
    loop,
    get gaveUp() {
      return gaveUp;
    },
    /** The stream connects and its ready asks for a read, as the live client does. */
    async connect() {
      stream.onStatus('connected');
      stream.onChange();
      await flush();
    },
  };
}

test('a failed read while connected is retried on nextCheckDelay, and the receipt turns paid', async () => {
  // First read: waiting, live on. The ready read answers; then tip.changed's read fails once.
  const h = harness([OPEN, OPEN, FAILED, PAID]);
  await flush();
  await h.connect();
  const before = h.reads.length;
  h.stream.onChange();
  await flush();
  assert.equal(h.reads.length, before + 1, 'the signal read');
  // No further signal will come for this change: the loop must try again by itself.
  await h.timers.advance(2000);
  assert.equal(h.reads.length, before + 2, 'one retry after the failed read');
  assert.equal(h.stream.stopped, 1, 'paid is final: the stream stops');
  // And nothing more is timed.
  await h.timers.advance(60_000);
  assert.equal(h.reads.length, before + 2);
});

test('while connected, an answered read arms nothing; a signal reads once', async () => {
  const h = harness([OPEN]);
  await flush();
  await h.connect();
  const atReady = h.reads.length;
  await h.timers.advance(5 * 60_000);
  assert.equal(h.reads.length, atReady, 'no timed reads while connected');
  h.stream.onChange();
  await flush();
  assert.equal(h.reads.length, atReady + 1);
  h.loop.stop();
});

test('a retry after a failure stops once a read answers again', async () => {
  const h = harness([OPEN, OPEN, FAILED, FAILED, OPEN]);
  await flush();
  await h.connect();
  const before = h.reads.length;
  h.stream.onChange();
  await flush();
  await h.timers.advance(10_000);
  // Failed, retried (failed), retried (answered): then quiet again.
  assert.equal(h.reads.length, before + 3);
  await h.timers.advance(5 * 60_000);
  assert.equal(h.reads.length, before + 3);
  h.loop.stop();
});

test('with live updates off it polls on nextCheckDelay and never follows', async () => {
  const h = harness([OPEN_OFF]);
  await flush();
  await h.timers.advance(12_000);
  // Every second for the first ten checks, then 2 s.
  assert.ok(h.reads.length >= 11, String(h.reads.length));
  assert.equal(h.stream.followed, 0);
  h.loop.stop();
});

test('not connected (connecting, polling), the receipt polls as today', async () => {
  const h = harness([OPEN]);
  await flush();
  assert.equal(h.stream.followed, 1);
  h.stream.onStatus('polling');
  await h.timers.advance(12_000);
  assert.ok(h.reads.length >= 11, String(h.reads.length));
  h.loop.stop();
});

test('a connected receipt gives up at 15 minutes and stops its stream', async () => {
  const h = harness([OPEN]);
  await flush();
  await h.connect();
  await h.timers.advance(15 * 60_000);
  assert.equal(h.gaveUp, 1);
  assert.equal(h.stream.stopped, 1);
  assert.equal(h.live.at(-1), 'idle');
});

test('back online while connected, it reads at once', async () => {
  const h = harness([OPEN]);
  await flush();
  await h.connect();
  const before = h.reads.length;
  h.loop.reconnected();
  await flush();
  assert.equal(h.reads.length, before + 1);
  h.loop.stop();
});
