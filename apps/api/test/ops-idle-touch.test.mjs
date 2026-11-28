import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_BACKGROUND_HEADER } from '@tipme/contracts';
import { touchesIdleClock } from '../dist/ops/ops.guard.js';

// Final review I1 (ruling L-R22): the grant's idle hour counts the person's own use only. The live
// stream itself never touches it, and neither do the reads a stream starts (ready, resync,
// signal), which say so with the background header. Everything else still touches.

const marked = { [LIVE_BACKGROUND_HEADER]: '1' };

test('the header name is the one the browser sends', () => {
  assert.equal(LIVE_BACKGROUND_HEADER, 'x-tipme-background');
});

test('a background GET does not touch; an unmarked GET does', () => {
  assert.equal(
    touchesIdleClock({ noTouchRoute: false, method: 'GET', headers: marked }),
    false,
  );
  assert.equal(
    touchesIdleClock({ noTouchRoute: false, method: 'GET', headers: {} }),
    true,
  );
});

test('a write always touches, marked or not: it is the person acting', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    assert.equal(
      touchesIdleClock({ noTouchRoute: false, method, headers: marked }),
      true,
      method,
    );
});

test('only the exact marker counts', () => {
  for (const value of ['0', 'true', '', ['1', '1']])
    assert.equal(
      touchesIdleClock({
        noTouchRoute: false,
        method: 'GET',
        headers: { [LIVE_BACKGROUND_HEADER]: value },
      }),
      true,
      JSON.stringify(value),
    );
});

test('the stream route never touches', () => {
  assert.equal(
    touchesIdleClock({ noTouchRoute: true, method: 'GET', headers: {} }),
    false,
  );
});
