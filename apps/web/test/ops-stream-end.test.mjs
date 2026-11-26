import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STREAM_END_RECHECK_MS,
  afterStreamEnd,
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
