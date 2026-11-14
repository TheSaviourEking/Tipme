import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_DRAIN_RETRY_MS } from '@tipme/contracts';
import { createLiveRouter, sseFrame } from '../dist/live/live-router.js';

const A_USER = '11111111-1111-4111-8111-111111111111';
const A_PROFILE = '22222222-2222-4222-8222-222222222222';
const B_USER = '33333333-3333-4333-8333-333333333333';
const B_PROFILE = '44444444-4444-4444-8444-444444444444';

function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    setTimer(fn, ms) {
      const timer = { fn, at: now + ms };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now && timers.has(timer)) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

function seeded(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function router(overrides = {}) {
  const clock = fakeClock();
  const hub = createLiveRouter({
    maxPerUser: 8,
    maxStreams: 2000,
    coalesceMs: 250,
    random: seeded(),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { hub, clock };
}

let next = 0;
function sink({
  kind = 'me',
  userId = A_USER,
  profileId = A_PROFILE,
  permissions = null,
  recheck,
} = {}) {
  const s = {
    id: `s${++next}`,
    kind,
    userId,
    profileId,
    permissions,
    writes: [],
    closed: null,
    write(frame) {
      s.writes.push(frame);
    },
    close(reason) {
      s.closed = reason;
    },
    recheck: recheck ?? (async () => true),
  };
  return s;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a profile signal reaches only that profile’s streams', () => {
  const { hub } = router();
  const a = sink();
  const b = sink({ userId: B_USER, profileId: B_PROFILE });
  hub.register(a);
  hub.register(b);
  hub.dispatch({ to: { profile: A_PROFILE }, type: 'tips.changed' });
  assert.deepEqual(a.writes, ['data: {"type":"tips.changed"}\n\n']);
  assert.deepEqual(b.writes, []);
});

test('a user signal reaches every stream of that user and no other', () => {
  const { hub } = router();
  const a1 = sink();
  const a2 = sink();
  const b = sink({ userId: B_USER, profileId: B_PROFILE });
  for (const s of [a1, a2, b]) hub.register(s);
  hub.dispatch({ to: { user: A_USER }, type: 'profile.changed' });
  assert.equal(a1.writes.length, 1);
  assert.equal(a2.writes.length, 1);
  assert.equal(b.writes.length, 0);
});

test('all reaches every me stream and no ops stream', () => {
  const { hub } = router();
  const a = sink();
  const b = sink({ userId: B_USER, profileId: null });
  const ops = sink({
    kind: 'ops',
    profileId: null,
    permissions: new Set(['issues.view']),
  });
  for (const s of [a, b, ops]) hub.register(s);
  hub.dispatch({ to: { all: true }, type: 'withdrawals.changed' });
  assert.equal(a.writes.length, 1);
  assert.equal(b.writes.length, 1);
  assert.equal(ops.writes.length, 0);
});

test('staff issues.view reaches only ops streams holding issues.view; staff any reaches every ops stream', () => {
  const { hub, clock } = router();
  const viewer = sink({
    kind: 'ops',
    profileId: null,
    permissions: new Set(['issues.view']),
  });
  const other = sink({
    kind: 'ops',
    userId: B_USER,
    profileId: null,
    permissions: new Set(['pages.view']),
  });
  const me = sink();
  for (const s of [viewer, other, me]) hub.register(s);
  hub.dispatch({ to: { staff: 'issues.view' }, type: 'ops.issues.changed' });
  assert.equal(viewer.writes.length, 1);
  assert.equal(other.writes.length, 0);
  clock.advance(250);
  hub.dispatch({ to: { staff: 'any' }, type: 'ops.approvals.changed' });
  assert.equal(viewer.writes.length, 2);
  assert.equal(other.writes.length, 1);
  assert.equal(me.writes.length, 0);
});

test('the browser receives only {type}', () => {
  const { hub, clock } = router();
  const a = sink();
  const ops = sink({
    kind: 'ops',
    profileId: null,
    permissions: new Set(['issues.view']),
  });
  hub.register(a);
  hub.register(ops);
  const messages = [
    { to: { profile: A_PROFILE }, type: 'tips.changed' },
    { to: { user: A_USER }, type: 'account.changed' },
    { to: { all: true }, type: 'withdrawals.changed' },
    { to: { staff: 'any' }, type: 'ops.approvals.changed' },
    { to: { staff: 'issues.view' }, type: 'ops.issues.changed' },
  ];
  for (const m of messages) {
    hub.dispatch(m);
    clock.advance(300);
  }
  const frames = [...a.writes, ...ops.writes];
  assert.equal(frames.length, messages.length);
  for (const frame of frames) {
    assert.match(frame, /^data: .*\n\n$/);
    const body = JSON.parse(frame.slice('data: '.length));
    assert.deepEqual(Object.keys(body), ['type']);
  }
});

test('sessions.changed is never forwarded', async () => {
  const { hub } = router();
  const gone = sink({ recheck: async () => false });
  const kept = sink({ recheck: async () => true });
  const other = sink({
    userId: B_USER,
    profileId: B_PROFILE,
    recheck: async () => false,
  });
  for (const s of [gone, kept, other]) hub.register(s);
  hub.dispatch({ to: { user: A_USER }, type: 'sessions.changed' });
  await tick();
  assert.deepEqual(gone.writes, ['data: {"type":"session.ended"}\n\n']);
  assert.equal(gone.closed, 'session_ended');
  assert.deepEqual(kept.writes, []);
  assert.equal(kept.closed, null);
  assert.deepEqual(other.writes, []);
  assert.equal(other.closed, null);
  assert.deepEqual(hub.counts(), { me: 2, ops: 0 });
});

test('a recheck that throws counts as gone', async () => {
  const { hub } = router();
  const s = sink({
    recheck: async () => {
      throw new Error('db down');
    },
  });
  hub.register(s);
  hub.dispatch({ to: { user: A_USER }, type: 'sessions.changed' });
  await tick();
  assert.equal(s.closed, 'session_ended');
});

test('staff.changed rechecks every ops stream and closes those whose grant is gone', async () => {
  const { hub } = router();
  const kept = sink({
    kind: 'ops',
    profileId: null,
    permissions: new Set(),
    recheck: async () => true,
  });
  const gone = sink({
    kind: 'ops',
    userId: B_USER,
    profileId: null,
    permissions: new Set(),
    recheck: async () => false,
  });
  let meChecked = false;
  const me = sink({
    recheck: async () => {
      meChecked = true;
      return false;
    },
  });
  for (const s of [kept, gone, me]) hub.register(s);
  hub.dispatch({ to: { staff: 'any' }, type: 'staff.changed' });
  await tick();
  assert.equal(kept.closed, null);
  assert.equal(gone.closed, 'session_ended');
  assert.equal(meChecked, false);
  assert.deepEqual(kept.writes, []);
});

test('the 9th stream for one user is refused limit_user', () => {
  const { hub } = router();
  for (let i = 0; i < 8; i += 1)
    assert.deepEqual(hub.register(sink()), { ok: true });
  assert.deepEqual(hub.register(sink()), { ok: false, reason: 'limit_user' });
  assert.deepEqual(
    hub.register(sink({ userId: B_USER, profileId: B_PROFILE })),
    { ok: true },
  );
});

test('stream 2001 is refused limit_process', () => {
  const { hub } = router({ maxPerUser: 1 });
  for (let i = 0; i < 2000; i += 1) {
    const userId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    assert.deepEqual(hub.register(sink({ userId, profileId: null })), {
      ok: true,
    });
  }
  assert.deepEqual(hub.register(sink({ userId: B_USER })), {
    ok: false,
    reason: 'limit_process',
  });
});

test('repeats of one type within 250 ms coalesce: one frame at once, one more at the window\u2019s end', () => {
  const { hub, clock } = router();
  const a = sink();
  hub.register(a);
  const m = { to: { profile: A_PROFILE }, type: 'tips.changed' };
  hub.dispatch(m);
  clock.advance(100);
  hub.dispatch(m);
  clock.advance(50);
  hub.dispatch(m);
  assert.equal(a.writes.length, 1, 'the first at once');
  clock.advance(99);
  assert.equal(a.writes.length, 1);
  // A repeat is never lost: something committed inside the window gets its own frame after it.
  clock.advance(1);
  assert.equal(a.writes.length, 2);
  assert.equal(a.writes[1], 'data: {"type":"tips.changed"}\n\n');
  // That flush opens the next window: at most one frame per type per 250 ms.
  hub.dispatch(m);
  assert.equal(a.writes.length, 2);
  clock.advance(250);
  assert.equal(a.writes.length, 3);
  // A quiet window closes: the next signal goes at once again.
  clock.advance(250);
  hub.dispatch(m);
  assert.equal(a.writes.length, 4);
});

test('a single signal is written once, with no flush after it', () => {
  const { hub, clock } = router();
  const a = sink();
  hub.register(a);
  hub.dispatch({ to: { profile: A_PROFILE }, type: 'tips.changed' });
  clock.advance(1000);
  assert.equal(a.writes.length, 1);
  assert.equal(clock.pending, 0);
});

test('a different type within the window is flushed once at its end', () => {
  const { hub, clock } = router();
  const a = sink();
  hub.register(a);
  hub.dispatch({ to: { profile: A_PROFILE }, type: 'tips.changed' });
  hub.dispatch({ to: { profile: A_PROFILE }, type: 'notifications.changed' });
  hub.dispatch({ to: { profile: A_PROFILE }, type: 'notifications.changed' });
  assert.deepEqual(a.writes, ['data: {"type":"tips.changed"}\n\n']);
  clock.advance(250);
  assert.deepEqual(a.writes, [
    'data: {"type":"tips.changed"}\n\n',
    'data: {"type":"notifications.changed"}\n\n',
  ]);
});

test('drain writes a retry between 1000 and 10000 to every stream and closes it', () => {
  const { hub, clock } = router();
  const sinks = Array.from({ length: 6 }, (_, i) =>
    sink({
      userId: `55555555-5555-4555-8555-00000000000${i}`,
      profileId: null,
    }),
  );
  sinks.push(sink({ kind: 'ops', profileId: null, permissions: new Set() }));
  for (const s of sinks) hub.register(s);
  hub.dispatch({ to: { all: true }, type: 'withdrawals.changed' });
  hub.drain();
  const retries = new Set();
  for (const s of sinks) {
    const last = s.writes.at(-1);
    const match = /^retry: (\d+)\n\n$/.exec(last);
    assert.ok(match, `expected a retry line, got ${JSON.stringify(last)}`);
    const ms = Number(match[1]);
    assert.ok(
      ms >= LIVE_DRAIN_RETRY_MS.min && ms <= LIVE_DRAIN_RETRY_MS.max,
      `retry ${ms} out of the shared range`,
    );
    retries.add(ms);
    assert.equal(s.closed, 'draining');
  }
  assert.ok(retries.size > 1, 'retries must differ across streams');
  assert.equal(hub.draining, true);
  assert.deepEqual(hub.register(sink()), { ok: false, reason: 'draining' });
  assert.deepEqual(hub.counts(), { me: 0, ops: 0 });
  assert.equal(clock.pending, 0, 'drain clears coalescing timers');
});

test('poll and resync control frames go to every stream', () => {
  const { hub } = router();
  const a = sink();
  const ops = sink({ kind: 'ops', profileId: null, permissions: new Set() });
  hub.register(a);
  hub.register(ops);
  hub.broadcastControl('poll');
  hub.broadcastControl('resync');
  for (const s of [a, ops]) {
    assert.deepEqual(s.writes, [
      sseFrame({ type: 'poll' }),
      sseFrame({ type: 'resync' }),
    ]);
  }
});

test('unregister removes a stream and clears its timer', () => {
  const { hub, clock } = router();
  const a = sink();
  hub.register(a);
  hub.dispatch({ to: { profile: A_PROFILE }, type: 'tips.changed' });
  hub.unregister(a.id);
  hub.unregister(a.id);
  assert.deepEqual(hub.counts(), { me: 0, ops: 0 });
  assert.equal(clock.pending, 0);
  hub.dispatch({ to: { profile: A_PROFILE }, type: 'moments.changed' });
  assert.equal(a.writes.length, 1);
});

test('onDelivered counts each written signal', () => {
  const delivered = [];
  const { hub } = router({ onDelivered: (type) => delivered.push(type) });
  hub.register(sink());
  hub.register(sink());
  hub.dispatch({ to: { user: A_USER }, type: 'account.changed' });
  assert.deepEqual(delivered, ['account.changed', 'account.changed']);
});

// Feature switches (owner, 14 Nov 2026): a change in admin clears every API copy's switches at once.
test('switches.changed clears this copy’s switches and reaches no browser', () => {
  let cleared = 0;
  const { hub, clock } = router({ onSwitchesChanged: () => (cleared += 1) });
  const me = sink();
  const ops = sink({ kind: 'ops', permissions: ['issues.view'] });
  hub.register(me);
  hub.register(ops);
  const before = me.writes.length + ops.writes.length;
  hub.dispatch({ to: { all: true }, type: 'switches.changed' });
  clock.advance(1000);
  assert.equal(cleared, 1);
  assert.equal(me.writes.length + ops.writes.length, before);
});
