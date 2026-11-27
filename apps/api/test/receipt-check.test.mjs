import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  receiptStreamCheckDelay,
  scheduleReceiptChecks,
} from '../dist/checkout/receipt-check.service.js';

test('receiptStreamCheckDelay: 4 s to 2 min, 15 s to 15 min, then null', () => {
  assert.equal(receiptStreamCheckDelay(0), 4_000);
  assert.equal(receiptStreamCheckDelay(119_999), 4_000);
  assert.equal(receiptStreamCheckDelay(120_000), 15_000);
  assert.equal(receiptStreamCheckDelay(899_999), 15_000);
  assert.equal(receiptStreamCheckDelay(900_000), null);
  assert.equal(receiptStreamCheckDelay(3_600_000), null);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function clock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const t = { fn, at: now + ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
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
    get pending() {
      return timers.size;
    },
  };
}

test('a stream checks every 4 s for 2 minutes, every 15 s to 15 minutes, then stops', async () => {
  const c = clock();
  const at = [];
  scheduleReceiptChecks({
    check: async () => (at.push(c.now()), false),
    onFinal: () => assert.fail('never final'),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  await c.advance(20 * 60_000);
  assert.deepEqual(at.slice(0, 3), [4_000, 8_000, 12_000]);
  // 30 checks in the first two minutes (4 s to 120 s), then 15 s apart until 15 minutes.
  assert.equal(at.filter((t) => t <= 120_000).length, 30);
  assert.equal(at[30], 135_000);
  assert.ok(at.at(-1) <= 15 * 60_000 + 15_000, String(at.at(-1)));
  assert.equal(c.pending, 0, 'nothing left armed');
});

test('a final tip ends the checks once; stop and a failing check behave', async () => {
  const c = clock();
  let calls = 0;
  let finals = 0;
  scheduleReceiptChecks({
    check: async () => {
      calls += 1;
      if (calls === 1) throw new Error('bachs down');
      return calls === 3;
    },
    onFinal: () => (finals += 1),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  await c.advance(60_000);
  assert.equal(calls, 3, 'a failed check waits for the next; final stops them');
  assert.equal(finals, 1);
  assert.equal(c.pending, 0);

  const s = clock();
  let checked = 0;
  const schedule = scheduleReceiptChecks({
    check: async () => (checked += 1) > 99,
    onFinal: () => assert.fail('stopped'),
    now: s.now,
    setTimer: s.setTimer,
    clearTimer: s.clearTimer,
  });
  await s.advance(8_000);
  schedule.stop();
  await s.advance(60_000);
  assert.equal(checked, 2);
  assert.equal(s.pending, 0);
});
