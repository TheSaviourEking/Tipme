import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followTip } from '../src/lib/tip-live.ts';

const TIP = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'receipt-token_abc';

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

/** Every connect answers `status`; a 200 streams what the test pushes. */
function fakeFetch(status) {
  const calls = [];
  const streams = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return new Response(null, { status });
    let controller;
    const body = new ReadableStream({ start: (c) => (controller = c) });
    init?.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'));
      } catch {
        // Closed already.
      }
    });
    streams.push({
      push: (text) => controller.enqueue(new TextEncoder().encode(text)),
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return { fetch, calls, streams };
}

function follow(status) {
  const timers = fakeTimers();
  const fake = fakeFetch(status);
  const changes = [];
  const statuses = [];
  const follower = followTip(
    {
      tipId: TIP,
      token: TOKEN,
      onChange: () => changes.push(timers.now()),
      onStatus: (s) => statuses.push(s),
    },
    {
      fetch: fake.fetch,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      random: () => 0.5,
      visible: () => true,
    },
  );
  return { timers, fake, changes, statuses, follower };
}

test('while polling, resyncs do not call onChange', async () => {
  const { timers, fake, changes, statuses, follower } = follow(429);
  await flush();
  assert.equal(statuses.at(-1), 'polling');
  // The client's own poll ticks (every 20 s) and stream retries run for minutes: the receipt's
  // own nextCheckDelay loop covers this time, so none of them reads.
  await timers.advance(5 * 60_000);
  assert.ok(fake.calls.length >= 2, 'the stream is retried');
  assert.deepEqual(changes, []);
  follower.stop();
  assert.equal(statuses.at(-1), 'idle');
});

test('connected: ready and tip.changed each call onChange; the token goes in the header only', async () => {
  const { timers, fake, changes, statuses, follower } = follow(200);
  await flush();
  assert.equal(fake.calls.length, 1);
  const { url, init } = fake.calls[0];
  assert.equal(url, `http://localhost:4000/v1/tips/${TIP}/events`);
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(url.includes(TOKEN), false);
  fake.streams[0].push('retry: 5000\n\ndata: {"type":"ready"}\n\n');
  await flush();
  assert.equal(statuses.at(-1), 'connected');
  assert.equal(changes.length, 1, 'the ready reads once');
  fake.streams[0].push('data: {"type":"tip.changed"}\n\n');
  await flush();
  assert.equal(changes.length, 2);
  // Any other type is not the receipt's: nothing happens.
  fake.streams[0].push('data: {"type":"tips.changed"}\n\n');
  await flush();
  assert.equal(changes.length, 2);
  // No safety refresh while connected: heartbeats only, and no reads for ten minutes.
  for (let i = 0; i < 30; i += 1) {
    fake.streams[0].push(': hb\nevent: hb\ndata: {}\n\n');
    await flush();
    await timers.advance(20_000);
  }
  assert.equal(changes.length, 2);
  follower.stop();
});
