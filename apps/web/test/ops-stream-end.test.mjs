import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STREAM_END_RECHECK_MS,
  afterStreamEnd,
  createStreamEndRecheck,
  keepsGrantedView,
} from '../src/lib/ops-stream-end.ts';

// The staff stream ended with 404 and the shell asked /v1/ops/me again. A passing failure there
// must not unmount the admin area (and lose the page's filters and pages); only an answer does.
test('after the stream ends, only a passing failure keeps the admin area showing', () => {
  assert.equal(keepsGrantedView({ step: 'retry' }), true);
  for (const step of [
    'needs_code',
    'needs_enrolment',
    'unavailable',
    'granted',
  ])
    assert.equal(keepsGrantedView({ step }), false, step);
  assert.equal(keepsGrantedView('signed_out'), false);
});

test('a passing failure asks again with backoff, then applies a real answer', () => {
  // Each passing failure waits longer before asking /v1/ops/me again.
  STREAM_END_RECHECK_MS.forEach((ms, attempt) =>
    assert.deepEqual(afterStreamEnd({ step: 'retry' }, attempt), {
      recheckInMs: ms,
    }),
  );
  for (let i = 1; i < STREAM_END_RECHECK_MS.length; i += 1)
    assert.ok(STREAM_END_RECHECK_MS[i] > STREAM_END_RECHECK_MS[i - 1]);
  // A later real answer (signed out, the code step, not staff) unmounts, whatever the attempt.
  assert.deepEqual(afterStreamEnd('signed_out', 2), { apply: true });
  assert.deepEqual(afterStreamEnd({ step: 'unavailable' }, 1), { apply: true });
  assert.deepEqual(afterStreamEnd({ step: 'needs_code' }, 0), { apply: true });
});

test('after the last retry the admin area stays, with its own timers', () => {
  assert.deepEqual(
    afterStreamEnd({ step: 'retry' }, STREAM_END_RECHECK_MS.length),
    { keep: true },
  );
});

/** A recheck on fake timers, with each /v1/ops/me question answered by hand. */
function recheckHarness() {
  const timers = new Map();
  let nextTimer = 0;
  const asks = [];
  const applied = [];
  const recheck = createStreamEndRecheck({
    ask: () =>
      new Promise((resolve) => {
        asks.push(resolve);
      }),
    apply: (next) => applied.push(next),
    setTimeout: (fn, ms) => {
      const id = (nextTimer += 1);
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const answer = async (next) => {
    asks.at(-1)(next);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { recheck, timers, asks, applied, answer };
}

test('the recheck applies a real answer and backs off after a passing failure', async () => {
  const h = recheckHarness();
  h.recheck.start();
  assert.equal(h.asks.length, 1);
  await h.answer({ step: 'retry' });
  assert.deepEqual(
    [...h.timers.values()].map((t) => t.ms),
    [STREAM_END_RECHECK_MS[0]],
  );
  const [[id, timer]] = h.timers;
  h.timers.delete(id);
  timer.fn();
  assert.equal(h.asks.length, 2);
  await h.answer('signed_out');
  assert.deepEqual(h.applied, ['signed_out']);
  assert.equal(h.timers.size, 0);
});

// Ops shell after unmount (final review Minor 4): a question still in flight when the shell goes
// must neither arm a new timer nor apply its answer (a sign-in redirect from a page already left).
test('after stop, an answer in flight neither applies nor arms a recheck', async () => {
  const signedOut = recheckHarness();
  signedOut.recheck.start();
  signedOut.recheck.stop();
  await signedOut.answer('signed_out');
  assert.deepEqual(signedOut.applied, []);

  const passing = recheckHarness();
  passing.recheck.start();
  passing.recheck.stop();
  await passing.answer({ step: 'retry' });
  assert.equal(passing.timers.size, 0, 'no timer armed after stop');
});

test('stop clears a recheck already waiting', async () => {
  const h = recheckHarness();
  h.recheck.start();
  await h.answer({ step: 'retry' });
  assert.equal(h.timers.size, 1);
  h.recheck.stop();
  assert.equal(h.timers.size, 0);
});
