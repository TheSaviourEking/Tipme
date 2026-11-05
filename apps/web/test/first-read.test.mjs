import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFirstRead, FIRST_READ_CAP_MS } from '../src/lib/first-read.ts';

function harness() {
  let now = 0;
  const timers = new Set();
  const reads = [];
  const first = createFirstRead({
    capMs: FIRST_READ_CAP_MS,
    setTimeout(fn, ms) {
      const t = { fn, at: now + ms };
      timers.add(t);
      return t;
    },
    clearTimeout(t) {
      timers.delete(t);
    },
    read: () => reads.push(now),
  });
  return {
    first,
    reads,
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at))
        if (t.at <= now && timers.has(t)) {
          timers.delete(t);
          t.fn();
        }
    },
    get pending() {
      return timers.size;
    },
  };
}

test('the cap is about 1.5 s', () => {
  assert.equal(FIRST_READ_CAP_MS, 1500);
});

test('while the stream connects, the first read waits for the ready resync, and only it reads', () => {
  const h = harness();
  h.first.update('hold');
  assert.deepEqual(h.reads, []);
  h.advance(400);
  // The ready resync runs the panel's reload: that is its first read.
  h.first.started();
  h.first.update('connected');
  h.advance(5000);
  assert.deepEqual(h.reads, [], 'no read of its own: one read on load');
  assert.equal(h.pending, 0);
});

test('a slow stream never blanks the page: the read goes ahead after 1.5 s', () => {
  const h = harness();
  h.first.update('hold');
  h.advance(1499);
  assert.deepEqual(h.reads, []);
  h.advance(1);
  assert.deepEqual(h.reads, [1500]);
  h.first.update('connected');
  h.advance(5000);
  assert.deepEqual(h.reads, [1500]);
});

test('refused, off or polling: the read goes ahead at once', () => {
  const h = harness();
  h.first.update('hold');
  h.advance(200);
  h.first.update('free');
  assert.deepEqual(h.reads, [200]);
  h.advance(5000);
  assert.deepEqual(h.reads, [200]);
  assert.equal(h.pending, 0);
});

test('no stream to wait for, or one already connected: read at once', () => {
  for (const phase of ['free', 'connected']) {
    const h = harness();
    h.first.update(phase);
    assert.deepEqual(h.reads, [0], phase);
    h.first.update(phase);
    assert.deepEqual(h.reads, [0], `${phase}: once`);
  }
});

test('held, then connected, but the resync never came: the cap still reads', () => {
  const h = harness();
  h.first.update('hold');
  h.advance(300);
  h.first.update('connected');
  assert.deepEqual(h.reads, []);
  h.advance(1200);
  assert.deepEqual(h.reads, [1500]);
});

test('dispose clears the cap', () => {
  const h = harness();
  h.first.update('hold');
  h.first.dispose();
  h.advance(5000);
  assert.deepEqual(h.reads, []);
  assert.equal(h.pending, 0);
});
