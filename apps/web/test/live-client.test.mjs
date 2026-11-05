import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVE_TIMING,
  backoffDelay,
  createLiveClient,
} from '../src/lib/live-client.ts';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

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
    /** Moves time forward, running every timer due on the way, in order. */
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
    get count() {
      return timers.size;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(o = {}) {
  const timers = fakeTimers();
  const sources = [];
  class FakeEventSource {
    constructor(url, init) {
      this.url = url;
      this.init = init;
      this.readyState = CONNECTING;
      this.closed = false;
      this.listeners = {};
      sources.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    close() {
      this.closed = true;
      this.readyState = CLOSED;
    }
    emitOpen() {
      this.readyState = OPEN;
      this.onopen?.({});
    }
    emitMessage(body) {
      this.onmessage?.({ data: JSON.stringify(body) });
    }
    emitError(closed = false) {
      this.readyState = closed ? CLOSED : CONNECTING;
      this.onerror?.({});
    }
    heartbeat() {
      for (const fn of this.listeners.hb ?? []) fn({ data: '{}' });
    }
  }
  let visible = true;
  let keepOpen = false;
  const probes = [];
  let probeAnswer = o.probe ?? 'ok';
  let random = o.random ?? 0.5;
  const client = createLiveClient({
    url: 'http://api.test/v1/me/events',
    EventSource: FakeEventSource,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    random: () => random,
    visible: () => visible,
    probe: async () => {
      probes.push(probeAnswer);
      return probeAnswer;
    },
    keepOpenWhenHidden: () => keepOpen,
  });
  const resyncs = [];
  const statuses = [];
  let signedOut = 0;
  client.onResync(() => resyncs.push(timers.now()));
  client.onStatus((s) => statuses.push(s));
  client.onSignedOut(() => (signedOut += 1));
  return {
    client,
    timers,
    sources,
    probes,
    resyncs,
    statuses,
    get signedOut() {
      return signedOut;
    },
    get es() {
      return sources.at(-1);
    },
    setVisible(v) {
      visible = v;
      client.visibilityChanged();
    },
    setKeepOpen(v) {
      keepOpen = v;
    },
    setProbe(v) {
      probeAnswer = v;
    },
    setRandom(v) {
      random = v;
    },
    async ready() {
      this.es.emitOpen();
      this.es.emitMessage({ type: 'ready' });
      await flush();
    },
  };
}

test('it connects with credentials to the stream url', () => {
  const h = harness();
  h.client.start();
  assert.equal(h.sources.length, 1);
  assert.equal(h.es.url, 'http://api.test/v1/me/events');
  assert.deepEqual(h.es.init, { withCredentials: true });
  assert.equal(h.client.status, 'connecting');
});

test('ready triggers one resync', async () => {
  const h = harness();
  h.client.start();
  await h.ready();
  assert.equal(h.resyncs.length, 1);
  assert.equal(h.client.status, 'connected');
});

test('a signal calls only its own listeners, and an unknown type is ignored', async () => {
  const h = harness();
  const tips = [];
  const notes = [];
  h.client.on('tips.changed', () => tips.push(1));
  h.client.on('notifications.changed', () => notes.push(1));
  h.client.start();
  await h.ready();
  h.es.emitMessage({ type: 'tips.changed' });
  h.es.emitMessage({ type: 'tips.exploded' });
  h.es.onmessage({ data: 'not json' });
  assert.equal(tips.length, 1);
  assert.equal(notes.length, 0);
  assert.equal(h.resyncs.length, 1);
});

test('backoff is full jitter within 1,2,4…60 s', () => {
  const caps = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000];
  caps.forEach((cap, i) => {
    const high = backoffDelay(i + 1, () => 0.999);
    assert.ok(high < cap && high >= cap * 0.99, `attempt ${i + 1}: ${high}`);
    assert.equal(
      backoffDelay(i + 1, () => 0),
      0,
    );
  });
});

test('a failed connect reconnects after the backoff, closing the EventSource itself', async () => {
  const h = harness({ random: 0.999 });
  h.client.start();
  h.es.emitOpen();
  h.es.emitError(false);
  assert.equal(h.sources[0].closed, true, 'the browser’s own retry never runs');
  await h.timers.advance(998);
  assert.equal(h.sources.length, 1);
  await h.timers.advance(2);
  assert.equal(h.sources.length, 2);
});

test('after 2 failed connects the client probes; unauthenticated fires onSignedOut and stops', async () => {
  const h = harness({ random: 0 });
  h.client.start();
  h.es.emitOpen();
  h.es.emitError(false);
  await h.timers.advance(0);
  assert.deepEqual(h.probes, []);
  h.setProbe('unauthenticated');
  h.es.emitOpen();
  h.es.emitError(false);
  await flush();
  assert.deepEqual(h.probes, ['unauthenticated']);
  assert.equal(h.signedOut, 1);
  assert.equal(h.client.status, 'idle');
  assert.equal(h.timers.count, 0);
  await h.timers.advance(600_000);
  assert.equal(h.sources.length, 2);
});

test('3 failures in a row switch to polling every 20 s ± 2 s while visible, and retry the stream every 60 s', async () => {
  const h = harness({ random: 0 });
  h.client.start();
  for (let i = 0; i < 3; i += 1) {
    h.es.emitOpen();
    h.es.emitError(false);
    await flush();
    await h.timers.advance(0);
  }
  assert.equal(h.client.status, 'polling');
  const streamsAtSwitch = h.sources.length;
  h.resyncs.length = 0;
  // random() is 0: each poll comes at 20 s - 2 s.
  await h.timers.advance(18_000);
  assert.deepEqual(h.resyncs, [h.timers.now()]);
  await h.timers.advance(18_000);
  assert.equal(h.resyncs.length, 2);
  h.setRandom(0.999);
  await h.timers.advance(24_000);
  // The stream is tried again 60 s after the switch.
  assert.equal(h.sources.length, streamsAtSwitch + 1);
  // A stream that gets ready ends the polling.
  await h.ready();
  assert.equal(h.client.status, 'connected');
  const before = h.resyncs.length;
  await h.timers.advance(40_000);
  assert.equal(h.resyncs.length, before);
});

test('poll intervals stay within 20 s ± 2 s', async () => {
  for (const r of [0, 0.5, 0.999]) {
    const h = harness({ random: r });
    h.client.start();
    await h.ready();
    h.es.emitMessage({ type: 'poll' });
    h.resyncs.length = 0;
    await h.timers.advance(22_000);
    assert.equal(h.resyncs.length, 1, `random ${r}`);
    const at = h.resyncs[0];
    assert.ok(at >= 18_000 && at <= 22_000, `${at}`);
    h.client.stop();
  }
});

test('a poll message switches to polling; resync returns to connected after a random 0–5 s', async () => {
  const h = harness({ random: 0.5 });
  h.client.start();
  await h.ready();
  h.es.emitMessage({ type: 'poll' });
  assert.equal(h.client.status, 'polling');
  assert.equal(h.es.closed, false, 'the stream stays open');
  await h.timers.advance(21_000);
  const polled = h.resyncs.length;
  h.es.emitMessage({ type: 'resync' });
  await h.timers.advance(2_499);
  assert.equal(h.resyncs.length, polled);
  await h.timers.advance(1);
  assert.equal(h.resyncs.length, polled + 1);
  assert.equal(h.client.status, 'connected');
});

test('resync waits a random 0–5 s before refetching', async () => {
  for (const [r, wait] of [
    [0, 0],
    [0.999, 4995],
  ]) {
    const h = harness({ random: r });
    h.client.start();
    await h.ready();
    h.resyncs.length = 0;
    h.es.emitMessage({ type: 'resync' });
    await h.timers.advance(Math.max(0, wait - 1));
    if (wait > 0) assert.equal(h.resyncs.length, 0);
    await h.timers.advance(1);
    assert.equal(h.resyncs.length, 1);
    h.client.stop();
  }
});

test('a 204 (closed before open, probe disabled) sets disabled and never reconnects or polls', async () => {
  const h = harness({ probe: 'disabled' });
  h.client.start();
  h.es.emitError(true);
  await flush();
  assert.equal(h.client.status, 'disabled');
  assert.equal(h.timers.count, 0);
  await h.timers.advance(3_600_000);
  assert.equal(h.sources.length, 1);
  assert.equal(h.resyncs.length, 0);
  h.client.online();
  h.setVisible(false);
  h.setVisible(true);
  assert.equal(h.sources.length, 1);
  assert.equal(h.resyncs.length, 0);
});

test('a refusal (429 or 503, closed before open) polls and retries the stream later', async () => {
  const h = harness({ probe: 'refused', random: 0 });
  h.client.start();
  h.es.emitError(true);
  await flush();
  assert.equal(h.client.status, 'polling');
  await h.timers.advance(18_000);
  assert.equal(h.resyncs.length, 1);
  await h.timers.advance(42_000);
  assert.equal(h.sources.length, 2);
});

test('the watchdog reconnects after 50 s with no message, heartbeat or ready', async () => {
  const h = harness();
  h.client.start();
  await h.ready();
  await h.timers.advance(40_000);
  h.es.heartbeat();
  await h.timers.advance(40_000);
  assert.equal(h.sources.length, 1, 'a heartbeat resets the watchdog');
  await h.timers.advance(10_000);
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[0].closed, true);
  await h.ready();
  assert.equal(h.client.status, 'connected');
});

test('open without ready for 10 s is treated as buffered: poll, and try the stream again after 5 minutes', async () => {
  const h = harness({ random: 0 });
  h.client.start();
  h.es.emitOpen();
  await h.timers.advance(9_999);
  assert.equal(h.client.status, 'connecting');
  await h.timers.advance(1);
  assert.equal(h.client.status, 'polling');
  assert.equal(h.sources[0].closed, true);
  await h.timers.advance(18_000);
  assert.ok(h.resyncs.length >= 1);
  await h.timers.advance(LIVE_TIMING.bufferedRetryMs - 18_000 - 1);
  assert.equal(h.sources.length, 1);
  await h.timers.advance(1);
  assert.equal(h.sources.length, 2);
});

test('hidden pauses polling at once and closes the stream after 5 minutes; visible reconnects and resyncs', async () => {
  const h = harness({ random: 0 });
  h.client.start();
  await h.ready();
  h.es.emitMessage({ type: 'poll' });
  h.setVisible(false);
  h.resyncs.length = 0;
  // Heartbeats every 20 s, so only the hidden-tab rule closes the stream.
  for (let s = 0; s < 14; s += 1) {
    await h.timers.advance(20_000);
    h.es.heartbeat();
  }
  await h.timers.advance(LIVE_TIMING.hiddenCloseMs - 14 * 20_000 - 1);
  assert.equal(h.resyncs.length, 0, 'no polling while hidden');
  assert.equal(h.es.closed, false);
  await h.timers.advance(1);
  assert.equal(h.sources[0].closed, true);
  await h.timers.advance(600_000);
  assert.equal(h.sources.length, 1, 'no reconnect while hidden');
  h.setVisible(true);
  assert.equal(h.sources.length, 2);
  // Not part of a herd: the tab came back by itself, so it re-reads at once, whatever random() says.
  h.setRandom(0.9);
  await h.ready();
  assert.equal(h.resyncs.length, 1);
});

test('visible again before 5 minutes refreshes once and keeps the stream', async () => {
  const h = harness();
  h.client.start();
  await h.ready();
  h.setVisible(false);
  await h.timers.advance(40_000);
  h.setVisible(true);
  h.es.heartbeat();
  assert.equal(h.sources.length, 1);
  assert.equal(h.resyncs.length, 2);
  for (let s = 0; s < 16; s += 1) {
    await h.timers.advance(20_000);
    h.es.heartbeat();
  }
  assert.equal(h.sources.length, 1);
  assert.equal(h.es.closed, false);
});

test('hidden keeps the stream open while keepOpenWhenHidden() is true', async () => {
  const h = harness();
  h.client.start();
  await h.ready();
  h.setKeepOpen(true);
  h.setVisible(false);
  // Heartbeats keep the watchdog quiet across 15 minutes.
  for (let s = 0; s < 45; s += 1) {
    await h.timers.advance(20_000);
    h.es.heartbeat();
  }
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].closed, false);
  h.setKeepOpen(false);
  for (let s = 0; s < 15; s += 1) {
    await h.timers.advance(20_000);
    if (!h.es.closed) h.es.heartbeat();
  }
  assert.equal(h.sources[0].closed, true);
});

test('online reconnects', async () => {
  const h = harness();
  h.client.start();
  await h.ready();
  h.client.online();
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[0].closed, true);
  // The network came back: no herd, so the re-read is at once.
  h.setRandom(0.9);
  await h.ready();
  assert.equal(h.resyncs.length, 2);
});

test('safety refresh runs every registered refetch every 5 minutes while connected and visible', async () => {
  const h = harness();
  h.client.start();
  await h.ready();
  h.resyncs.length = 0;
  for (let i = 1; i <= 3; i += 1) {
    // Heartbeats every 20 s keep the stream alive across the 5 minutes.
    for (let s = 0; s < 15; s += 1) {
      await h.timers.advance(20_000);
      h.es.heartbeat();
    }
    assert.equal(h.resyncs.length, i);
  }
  h.setVisible(false);
  h.setKeepOpen(true);
  const hiddenAt = h.resyncs.length;
  for (let s = 0; s < 15; s += 1) {
    await h.timers.advance(20_000);
    h.es.heartbeat();
  }
  assert.equal(h.resyncs.length, hiddenAt, 'no safety refresh while hidden');
});

test('session.ended probes; unauthenticated signs out', async () => {
  const h = harness({ probe: 'unauthenticated' });
  h.client.start();
  await h.ready();
  h.es.emitMessage({ type: 'session.ended' });
  await flush();
  assert.equal(h.signedOut, 1);
  assert.equal(h.client.status, 'idle');
});

test('stop closes the EventSource and clears every timer', async () => {
  const h = harness();
  h.client.start();
  await h.ready();
  h.es.emitMessage({ type: 'poll' });
  h.setVisible(false);
  assert.ok(h.timers.count > 0);
  h.client.stop();
  assert.equal(h.es.closed, true);
  assert.equal(h.timers.count, 0);
  assert.equal(h.client.status, 'idle');
});

test('a stream that was ready and closes reconnects after 1–10 s, as the draining copy asks', async () => {
  for (const [r, wait] of [
    [0, 1000],
    [0.5, 5500],
    [0.999, 9991],
  ]) {
    const h = harness({ random: r });
    h.client.start();
    await h.ready();
    // A drain (retry line, then close) or the 30-minute close: the server ended a healthy stream.
    h.es.emitError(false);
    await flush();
    assert.deepEqual(h.probes, [], 'a healthy close is not a failure to probe');
    await h.timers.advance(wait - 1);
    assert.equal(h.sources.length, 1, `random ${r}: not before ${wait} ms`);
    await h.timers.advance(1);
    assert.equal(h.sources.length, 2, `random ${r}: at ${wait} ms`);
    h.client.stop();
  }
});

test('the first ready refetches at once; a ready after a reconnect refetches after 0–5 s', async () => {
  const h = harness({ random: 0.6 });
  const kinds = [];
  h.client.onResync((o) => kinds.push(o?.immediate === true));
  h.client.start();
  await h.ready();
  assert.equal(h.resyncs.length, 1);
  assert.deepEqual(kinds, [true]);
  h.es.emitError(false);
  await h.timers.advance(6400);
  assert.equal(h.sources.length, 2);
  await h.ready();
  assert.equal(h.resyncs.length, 1, 'not at once');
  await h.timers.advance(2999);
  assert.equal(h.resyncs.length, 1);
  await h.timers.advance(1);
  assert.equal(h.resyncs.length, 2, 'after random 0.6 × 5 s');
  assert.deepEqual(kinds, [true, false]);
});

test('a deploy’s herd is spread: reconnects over 1–10 s and refetches over a further 0–5 s', async () => {
  // A hundred tabs on a draining copy, each with its own random draws.
  let seed = 11;
  const draw = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const reconnectAt = [];
  const refetchAt = [];
  for (let i = 0; i < 100; i += 1) {
    const h = harness();
    h.setRandom(draw());
    h.client.start();
    await h.ready();
    const drained = h.timers.now();
    h.es.emitError(false);
    await flush();
    while (h.sources.length === 1) await h.timers.advance(50);
    reconnectAt.push(h.timers.now() - drained);
    h.setRandom(draw());
    const before = h.resyncs.length;
    await h.ready();
    const readyAt = h.timers.now();
    while (h.resyncs.length === before) await h.timers.advance(50);
    refetchAt.push(h.timers.now() - readyAt);
    h.client.stop();
  }
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  assert.ok(
    Math.min(...reconnectAt) >= 1000 && Math.max(...reconnectAt) <= 10_050,
    `${Math.min(...reconnectAt)}..${Math.max(...reconnectAt)}`,
  );
  assert.ok(
    spread(reconnectAt) > 7000,
    `reconnects spread over ${spread(reconnectAt)} ms`,
  );
  // No more than a fifth of the tabs reconnect in any one second.
  for (let s = 1000; s < 10_000; s += 1000)
    assert.ok(
      reconnectAt.filter((t) => t >= s && t < s + 1000).length <= 20,
      `second ${s}`,
    );
  assert.ok(
    Math.max(...refetchAt) <= 5050 && spread(refetchAt) > 3500,
    `refetches spread over ${spread(refetchAt)} ms`,
  );
});

test('the client waits within the same range the draining hub sends (one shared constant)', async () => {
  const { LIVE_DRAIN_RETRY_MS } = await import('@tipme/contracts');
  assert.equal(LIVE_TIMING.closedRetryMinMs, LIVE_DRAIN_RETRY_MS.min);
  assert.equal(LIVE_TIMING.closedRetryMaxMs, LIVE_DRAIN_RETRY_MS.max);
});
