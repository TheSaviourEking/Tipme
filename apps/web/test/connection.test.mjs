import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUIET_RETRY,
  connectionProblem,
  onReconnect,
  retryable,
  sendWithOneRetry,
} from '../src/lib/connection.ts';

const NETWORK = { ok: false, code: 'NETWORK' };
const OK = { ok: true };
/** A send that answers from a list, counting calls. */
function answers(...list) {
  const send = async () => {
    send.calls += 1;
    return list[Math.min(send.calls - 1, list.length - 1)];
  };
  send.calls = 0;
  return send;
}
const noWait = () => {
  const wait = async (ms) => {
    wait.waits.push(ms);
  };
  wait.waits = [];
  return wait;
};

test('a NETWORK answer while online is sent once more, the same request, after 400–800 ms', async () => {
  const send = answers(NETWORK, OK);
  const wait = noWait();
  const outcome = await sendWithOneRetry('tip-intent', send, {
    online: () => true,
    wait,
    random: () => 0.5,
  });
  assert.deepEqual(wait.waits, [600]);
  assert.equal(send.calls, 2);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.firstWasNetwork, true);
  assert.equal(outcome.result.ok, true);
  // The bounds of the jitter.
  for (const [random, ms] of [
    [0, 400],
    [0.999, 799.6],
  ]) {
    const w = noWait();
    await sendWithOneRetry('tip-quote', answers(NETWORK, OK), {
      online: () => true,
      wait: w,
      random: () => random,
    });
    assert.deepEqual(w.waits, [ms]);
  }
});

test('never more than one retry', async () => {
  const send = answers(NETWORK, NETWORK, OK);
  const outcome = await sendWithOneRetry('sign-in-verify', send, {
    online: () => true,
    wait: noWait(),
  });
  assert.equal(send.calls, 2);
  assert.equal(outcome.result.code, 'NETWORK');
  assert.equal(outcome.retried, true);
});

test('no retry when offline: the caller waits for reconnect', async () => {
  const send = answers(NETWORK, OK);
  const wait = noWait();
  const outcome = await sendWithOneRetry('welcome-profile', send, {
    online: () => false,
    wait,
  });
  assert.equal(send.calls, 1);
  assert.deepEqual(wait.waits, []);
  assert.equal(outcome.retried, false);
  assert.equal(outcome.firstWasNetwork, true);
});

test('no retry for any answer but NETWORK', async () => {
  for (const code of ['INTERNAL_ERROR', 'CODE_INVALID', 'RATE_LIMITED']) {
    const send = answers({ ok: false, code }, OK);
    const outcome = await sendWithOneRetry('tip-intent', send, {
      online: () => true,
      wait: noWait(),
    });
    assert.equal(send.calls, 1, code);
    assert.equal(outcome.retried, false);
    assert.equal(outcome.firstWasNetwork, false);
  }
  const send = answers(OK);
  await sendWithOneRetry('welcome-live', send, { wait: noWait() });
  assert.equal(send.calls, 1);
});

test('withdrawals, sending a code and staff actions are never quietly retried', async () => {
  for (const surface of [
    'withdrawal',
    'send-code',
    'ops-action',
    'bank-account',
  ]) {
    assert.equal(retryable(surface), false, surface);
    const send = answers(NETWORK, OK);
    await assert.rejects(
      sendWithOneRetry(surface, send, { online: () => true, wait: noWait() }),
      TypeError,
    );
    assert.equal(send.calls, 0, surface);
  }
  for (const surface of QUIET_RETRY) assert.equal(retryable(surface), true);
  assert.deepEqual([...QUIET_RETRY].sort(), [
    'sign-in-verify',
    'tip-intent',
    'tip-quote',
    'welcome-live',
    'welcome-profile',
  ]);
});

test('offline and no answer are told apart', () => {
  assert.equal(connectionProblem(NETWORK, false), 'offline');
  assert.equal(connectionProblem(NETWORK, true), 'no-answer');
  assert.equal(connectionProblem(OK, true), null);
  assert.equal(connectionProblem(OK, false), null);
  assert.equal(
    connectionProblem({ ok: false, code: 'INTERNAL_ERROR' }, true),
    null,
  );
});

test('a reconnect runs the send once and can be cancelled', () => {
  const target = new EventTarget();
  let runs = 0;
  onReconnect(target, () => {
    runs += 1;
  });
  target.dispatchEvent(new Event('online'));
  target.dispatchEvent(new Event('online'));
  assert.equal(runs, 1);
  let cancelledRuns = 0;
  const cancel = onReconnect(target, () => {
    cancelledRuns += 1;
  });
  cancel();
  target.dispatchEvent(new Event('online'));
  assert.equal(cancelledRuns, 0);
  // Cancelling after it ran is harmless.
  const late = onReconnect(target, () => {});
  target.dispatchEvent(new Event('online'));
  late();
});
