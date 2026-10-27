import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextCheckDelay } from '../src/lib/status-polling.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

test('the receipt checks quickly at first, then keeps checking slowly for 15 minutes', () => {
  assert.equal(nextCheckDelay(0, 0), SECOND);
  assert.equal(nextCheckDelay(9, 9 * SECOND), SECOND);
  assert.equal(nextCheckDelay(10, 12 * SECOND), 2 * SECOND);
  assert.equal(nextCheckDelay(20, 45 * SECOND), 5 * SECOND);
  // A provider can take a few minutes to confirm: no giving up at 2 minutes.
  assert.equal(nextCheckDelay(40, 2 * MINUTE), 15 * SECOND);
  assert.equal(nextCheckDelay(80, 14 * MINUTE), 15 * SECOND);
  // After 15 minutes the page offers "Try again" instead.
  assert.equal(nextCheckDelay(120, 15 * MINUTE), null);
});
