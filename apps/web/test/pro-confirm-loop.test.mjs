import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startProConfirmLoop } from '../src/lib/pro-confirm-loop.ts';

// Settings' "confirming" slip (addendum §3.7): polling as today while the dashboard stream is not
// connected; connected, reads only when told, except to retry a read that got no answer.

const flush = async () => {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function fakeTimers() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    pending: () => timers.size,
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

/** A loop whose reads answer from `answers` in turn (the last one repeats). */
function harness(answers, { connected = false } = {}) {
  const timers = fakeTimers();
  const reads = [];
  const queue = [...answers];
  let gaveUp = 0;
  let release = null;
  const h = {
    timers,
    reads,
    /** Set: the next read waits until `h.release()`. */
    hold: false,
    release: () => release?.(),
    get gaveUp() {
      return gaveUp;
    },
  };
  h.loop = startProConfirmLoop({
    read: async () => {
      reads.push(timers.now());
      if (h.hold) await new Promise((done) => (release = done));
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    connected,
    onGiveUp: () => (gaveUp += 1),
  });
  return h;
}

test('not connected: reads follow nextCheckDelay, as today', async () => {
  const h = harness(['open']);
  await flush();
  await h.timers.advance(16_000);
  // Every second for the first ten checks, then 2 s until 30 s.
  assert.deepEqual(
    h.reads,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16].map((s) => s * 1000),
  );
  h.loop.stop();
});

test('not connected: gives up after 15 minutes, as today, with no timer of its own', async () => {
  const h = harness(['open']);
  await flush();
  await h.timers.advance(15 * 60_000 + 15_000);
  assert.equal(h.gaveUp, 1);
  const count = h.reads.length;
  await h.timers.advance(60_000);
  assert.equal(h.reads.length, count);
  assert.equal(h.timers.pending(), 0);
});

test('connected: one read, then nothing until a signal, then exactly one read', async () => {
  const h = harness(['open'], { connected: true });
  await flush();
  await h.timers.advance(5 * 60_000);
  assert.deepEqual(h.reads, [0]);
  await h.loop.signal();
  assert.equal(h.reads.length, 2);
  await h.timers.advance(5 * 60_000);
  assert.equal(h.reads.length, 2);
  h.loop.stop();
});

test('connected: a read that got no answer is still retried on nextCheckDelay', async () => {
  const h = harness(['open', 'failed', 'failed', 'open'], { connected: true });
  await flush();
  await h.loop.signal(); // failed
  const at = h.timers.now();
  await h.timers.advance(1000); // failed again: retried
  await h.timers.advance(1000); // answered: the stream says when from here
  assert.deepEqual(h.reads, [0, at, at + 1000, at + 2000]);
  await h.timers.advance(60_000);
  assert.equal(h.reads.length, 4);
  h.loop.stop();
});

test('the stream dropping resumes polling; reconnecting stops it', async () => {
  const h = harness(['open'], { connected: true });
  await flush();
  h.loop.setConnected(false);
  await h.timers.advance(3000);
  assert.equal(h.reads.length, 4);
  h.loop.setConnected(true);
  await h.timers.advance(60_000);
  assert.equal(h.reads.length, 4);
  h.loop.stop();
});

test('connected for 15 minutes with no answer: gives up, as polling would', async () => {
  const h = harness(['open'], { connected: true });
  await flush();
  await h.timers.advance(15 * 60_000 - 1);
  assert.equal(h.gaveUp, 0);
  await h.timers.advance(1);
  assert.equal(h.gaveUp, 1);
  await h.loop.signal();
  assert.equal(h.reads.length, 1);
  assert.equal(h.timers.pending(), 0);
});

test('an answer ends the round: later signals read nothing', async () => {
  const h = harness(['open', 'done'], { connected: true });
  await flush();
  await h.loop.signal();
  await h.loop.signal();
  assert.equal(h.reads.length, 2);
  assert.equal(h.timers.pending(), 0);
});

test('signals during a read give exactly one more read after it', async () => {
  const h = harness(['open'], { connected: true });
  await flush();
  h.hold = true;
  const first = h.loop.signal();
  await flush();
  void h.loop.signal();
  void h.loop.signal();
  h.hold = false;
  h.release();
  await first;
  await flush();
  assert.equal(h.reads.length, 3);
  h.loop.stop();
});

test('stopped: no more reads or timers', async () => {
  const h = harness(['open']);
  await flush();
  h.loop.stop();
  await h.timers.advance(60_000);
  await h.loop.signal();
  assert.deepEqual(h.reads, [0]);
  assert.equal(h.timers.pending(), 0);
});
