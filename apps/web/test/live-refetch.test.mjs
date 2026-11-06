import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRefetchScheduler } from '../src/lib/live-refetch.ts';
import { nextPanelState } from '../src/components/dashboard/panel-state.ts';

function fakeTimers() {
  let now = 0;
  const timers = new Set();
  return {
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
      await flush();
    },
    get count() {
      return timers.size;
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

/** A refetch whose promise the test settles by hand. */
function controlled() {
  const calls = [];
  const fn = () =>
    new Promise((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { fn, calls };
}

function scheduler() {
  const timers = fakeTimers();
  const s = createRefetchScheduler({
    debounceMs: 300,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { s, timers };
}

test('signals within 300 ms run a registration’s refetch once', async () => {
  const { s, timers } = scheduler();
  let runs = 0;
  s.register(['tips.changed', 'withdrawals.changed'], async () => {
    runs += 1;
  });
  s.signal('tips.changed');
  await timers.advance(100);
  s.signal('withdrawals.changed');
  await timers.advance(100);
  s.signal('tips.changed');
  assert.equal(runs, 0);
  await timers.advance(100);
  assert.equal(runs, 1);
  await timers.advance(1000);
  assert.equal(runs, 1);
});

test('a signal only runs registrations for its type', async () => {
  const { s, timers } = scheduler();
  const ran = [];
  s.register(['tips.changed'], async () => void ran.push('tips'));
  s.register(['reports.changed'], async () => void ran.push('reports'));
  s.signal('reports.changed');
  await timers.advance(300);
  assert.deepEqual(ran, ['reports']);
});

test('a signal during an in-flight refetch runs exactly one more after it', async () => {
  const { s, timers } = scheduler();
  const c = controlled();
  s.register(['tips.changed'], c.fn);
  s.signal('tips.changed');
  await timers.advance(300);
  assert.equal(c.calls.length, 1);
  s.signal('tips.changed');
  await timers.advance(300);
  assert.equal(c.calls.length, 1, 'never two at once');
  c.calls[0].resolve();
  await flush();
  assert.equal(c.calls.length, 2);
  c.calls[1].resolve();
  await timers.advance(1000);
  assert.equal(c.calls.length, 2);
});

test('two signals during an in-flight refetch still run only one more', async () => {
  const { s, timers } = scheduler();
  const c = controlled();
  s.register(['tips.changed'], c.fn);
  s.signal('tips.changed');
  await timers.advance(300);
  s.signal('tips.changed');
  await timers.advance(300);
  s.signal('tips.changed');
  await timers.advance(300);
  c.calls[0].resolve();
  await flush();
  c.calls[1]?.resolve();
  await timers.advance(1000);
  assert.equal(c.calls.length, 2);
});

test('resyncAll runs every registration once, including those with no matching type', async () => {
  const { s, timers } = scheduler();
  const ran = [];
  s.register(['tips.changed'], async () => void ran.push('a'));
  s.register([], async () => void ran.push('b'));
  s.resyncAll();
  s.resyncAll();
  await timers.advance(300);
  assert.deepEqual(ran.sort(), ['a', 'b']);
});

test('an unregistered refetch never runs', async () => {
  const { s, timers } = scheduler();
  let runs = 0;
  const off = s.register(['tips.changed'], async () => {
    runs += 1;
  });
  s.signal('tips.changed');
  off();
  await timers.advance(1000);
  s.resyncAll();
  await timers.advance(1000);
  assert.equal(runs, 0);
  assert.equal(timers.count, 0);
});

test('a refetch that rejects does not block the next', async () => {
  const { s, timers } = scheduler();
  const c = controlled();
  s.register(['tips.changed'], c.fn);
  s.signal('tips.changed');
  await timers.advance(300);
  c.calls[0].reject(new Error('offline'));
  await flush();
  s.signal('tips.changed');
  await timers.advance(300);
  assert.equal(c.calls.length, 2);
});

test('a failed reload keeps data and updatedAt', () => {
  const at = new Date('2026-11-05T13:02:00Z');
  const later = new Date('2026-11-05T13:07:00Z');
  const loaded = nextPanelState(
    { data: null, error: null, updatedAt: null },
    { ok: true, data: { n: 1 } },
    at,
  );
  assert.deepEqual(loaded, { data: { n: 1 }, error: null, updatedAt: at });
  const failed = nextPanelState(loaded, { ok: false }, later);
  assert.deepEqual(failed, { data: { n: 1 }, error: 'refresh', updatedAt: at });
  assert.deepEqual(
    nextPanelState(
      { data: null, error: null, updatedAt: null },
      { ok: false },
      at,
    ),
    {
      data: null,
      error: 'load',
      updatedAt: null,
    },
  );
  const again = nextPanelState(failed, { ok: true, data: { n: 2 } }, later);
  assert.deepEqual(again, { data: { n: 2 }, error: null, updatedAt: later });
});

test('a registration made with resync: false hears its signals but not resyncs', async () => {
  const { s, timers } = scheduler();
  let runs = 0;
  s.register(
    ['tips.changed'],
    async () => {
      runs += 1;
    },
    { resync: false },
  );
  s.resyncAll();
  await timers.advance(1000);
  assert.equal(runs, 0);
  s.signal('tips.changed');
  await timers.advance(300);
  assert.equal(runs, 1);
});

test('resyncAll with delayMs 0 reads at once (the page’s first ready: its panels’ first read)', async () => {
  const { s, timers } = scheduler();
  let runs = 0;
  s.register([], async () => {
    runs += 1;
  });
  s.resyncAll({ delayMs: 0 });
  await timers.advance(0);
  assert.equal(runs, 1);
});
