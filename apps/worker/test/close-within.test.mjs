import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeWithin } from '../dist/close-within.js';

test('a graceful close that finishes in time is used', async () => {
  let forced = false;
  assert.equal(
    await closeWithin(
      1000,
      async () => {},
      async () => {
        forced = true;
      },
    ),
    'graceful',
  );
  assert.equal(forced, false);
});

test('a graceful close that hangs is abandoned and the force path runs', async () => {
  let forced = false;
  const started = performance.now();
  const result = await closeWithin(
    50,
    () => new Promise(() => {}),
    async () => {
      forced = true;
    },
  );
  assert.equal(result, 'forced');
  assert.ok(forced);
  assert.ok(performance.now() - started < 1000);
});
