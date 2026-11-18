import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import {
  CLAIM_BUTTON_LABEL,
  CLAIM_CHECK_DELAY_MS,
  CLAIM_FORMAT_HINT,
  ClaimChecker,
  claimCandidate,
  claimMessage,
  stateFromResult,
} from '../src/lib/claim-check.ts';

// Home's claim field (owner, 18 Nov 2026): "Claim username", a live check once they stop typing,
// and a nudge on the button when the name is free.

test('the claim button says "Claim username"', () => {
  assert.equal(CLAIM_BUTTON_LABEL, 'Claim username');
  const source = readFileSync(
    new URL('../src/components/home-claim.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /CLAIM_BUTTON_LABEL/);
  assert.doesNotMatch(source, /Get tipped/);
  // Home passes no other words: the nav keeps "Get tipped", this form does not.
  const home = readFileSync(
    new URL('../src/app/page.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(home, /<HomeClaim label=/);
});

test('only a name that can pass the handle rule is checked, lowercased', () => {
  assert.deepEqual(claimCandidate(''), { kind: 'empty' });
  assert.deepEqual(claimCandidate('   '), { kind: 'empty' });
  assert.deepEqual(claimCandidate('ab'), { kind: 'invalid' });
  assert.deepEqual(claimCandidate('a-b-c'), { kind: 'invalid' });
  assert.deepEqual(claimCandidate('x'.repeat(31)), { kind: 'invalid' });
  assert.deepEqual(claimCandidate(' Kemi_Cuts '), {
    kind: 'check',
    handle: 'kemi_cuts',
  });
  assert.deepEqual(claimCandidate('@Ada2'), { kind: 'check', handle: 'ada2' });
});

test('each answer maps to its state, and failures say nothing', () => {
  const ok = (status, handle = 'kemi') => ({
    ok: true,
    status: 200,
    data: { handle, status },
  });
  assert.deepEqual(stateFromResult('kemi', ok('available')), {
    kind: 'available',
    handle: 'kemi',
  });
  assert.deepEqual(stateFromResult('kemi', ok('available', null)), {
    kind: 'available',
    handle: 'kemi',
  });
  assert.deepEqual(stateFromResult('kemi', ok('taken')), { kind: 'taken' });
  assert.deepEqual(stateFromResult('kemi', ok('reserved')), {
    kind: 'reserved',
  });
  assert.deepEqual(stateFromResult('kemi', ok('invalid')), {
    kind: 'invalid',
  });
  assert.deepEqual(
    stateFromResult('kemi', { ok: false, status: 0, code: 'NETWORK' }),
    { kind: 'unknown' },
  );
  assert.deepEqual(
    stateFromResult('kemi', { ok: false, status: 503, code: 'INTERNAL_ERROR' }),
    { kind: 'unknown' },
  );
  // Rate limited: stop asking for this visit, quietly.
  assert.deepEqual(
    stateFromResult('kemi', { ok: false, status: 429, code: 'RATE_LIMITED' }),
    { kind: 'paused' },
  );
});

test('the messages are plain, and a reserved name is never called reserved', () => {
  assert.equal(
    claimMessage({ kind: 'available', handle: 'kemi' }),
    '@kemi is available',
  );
  assert.equal(claimMessage({ kind: 'taken' }), 'That username is taken.');
  assert.equal(
    claimMessage({ kind: 'reserved' }),
    'That username isn’t available.',
  );
  assert.doesNotMatch(claimMessage({ kind: 'reserved' }), /reserv|brand/i);
  assert.equal(claimMessage({ kind: 'invalid' }), CLAIM_FORMAT_HINT);
  assert.equal(
    CLAIM_FORMAT_HINT,
    '3 to 30 letters, numbers or underscores. Capitals become lowercase.',
  );
  for (const kind of ['idle', 'typing', 'unknown', 'paused'])
    assert.equal(claimMessage({ kind }), '');
  assert.equal(claimMessage({ kind: 'checking', handle: 'kemi' }), '');
});

/** A checker with a lookup the test answers by hand. */
function harness() {
  const states = [];
  const calls = [];
  const checker = new ClaimChecker({
    lookup: (handle, signal) =>
      new Promise((resolve) => {
        calls.push({ handle, signal, resolve });
      }),
    onChange: (state) => states.push(state),
  });
  return { checker, states, calls };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const answer = (status, handle) => ({
  ok: true,
  status: 200,
  data: { handle, status },
});

test('the check waits until they stop typing, then asks once', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  assert.ok(CLAIM_CHECK_DELAY_MS >= 400 && CLAIM_CHECK_DELAY_MS <= 500);
  const { checker, states, calls } = harness();
  for (const typed of ['k', 'ke', 'kem', 'kemi']) {
    checker.input(typed);
    mock.timers.tick(CLAIM_CHECK_DELAY_MS - 1);
  }
  assert.equal(calls.length, 0, 'nothing asked while typing');
  // Never an error while typing, even for the too-short start.
  assert.ok(states.every((state) => state.kind === 'typing'));
  mock.timers.tick(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].handle, 'kemi');
  assert.deepEqual(states.at(-1), { kind: 'checking', handle: 'kemi' });
  calls[0].resolve(answer('available', 'kemi'));
  await flush();
  assert.deepEqual(states.at(-1), { kind: 'available', handle: 'kemi' });
});

test('typing again cancels the request in flight, and its late answer is ignored', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { checker, states, calls } = harness();
  checker.input('kemi');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  assert.equal(calls.length, 1);
  checker.input('kemi_');
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(answer('available', 'kemi'));
  await flush();
  assert.deepEqual(states.at(-1), { kind: 'typing' });
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  calls[1].resolve(answer('taken', 'kemi_'));
  await flush();
  assert.deepEqual(states.at(-1), { kind: 'taken' });
});

test('a name that breaks the rule shows the hint after the pause, with no request', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { checker, states, calls } = harness();
  checker.input('ab');
  assert.deepEqual(states.at(-1), { kind: 'typing' });
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  assert.deepEqual(states.at(-1), { kind: 'invalid' });
  checker.input('');
  assert.deepEqual(states.at(-1), { kind: 'idle' });
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  assert.equal(calls.length, 0);
});

test('an answered name is not asked again; a failed one is', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { checker, states, calls } = harness();
  checker.input('kemi');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  calls[0].resolve(answer('taken', 'kemi'));
  await flush();
  checker.input('kemi_');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  calls[1].resolve({ ok: false, status: 0, code: 'NETWORK' });
  await flush();
  assert.deepEqual(states.at(-1), { kind: 'unknown' });
  checker.input('kemi');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  assert.deepEqual(states.at(-1), { kind: 'taken' });
  assert.equal(calls.length, 2, 'kemi came from the first answer');
  checker.input('kemi_');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  assert.equal(calls.length, 3, 'the failed name is asked again');
});

test('once rate limited, it stops asking and stays quiet', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { checker, states, calls } = harness();
  checker.input('kemi');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  calls[0].resolve({ ok: false, status: 429, code: 'RATE_LIMITED' });
  await flush();
  checker.input('kemi_cuts');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  assert.equal(calls.length, 1);
  assert.equal(claimMessage(states.at(-1)), '');
});

test('dispose cancels the timer and the request', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { checker, calls } = harness();
  checker.input('kemi');
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  checker.input('kemi_cuts');
  checker.dispose();
  assert.equal(calls[0].signal.aborted, true);
  mock.timers.tick(CLAIM_CHECK_DELAY_MS);
  assert.equal(calls.length, 1);
});
