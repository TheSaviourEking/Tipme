import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepsGrantedView } from '../src/lib/ops-stream-end.ts';

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
