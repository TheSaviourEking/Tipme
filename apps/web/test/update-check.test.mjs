import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  READY_CHECK_GAP_MS,
  readyMayCheck,
  updateCheckEveryMs,
} from '../src/lib/update-check.ts';

// The update notice's own timer (addendum §3.5): a page with a connected stream checks on each
// stream ready instead; a live provider whose stream isn't connected keeps today's 5 minutes; a
// page with no live provider at all checks every 30 minutes.
test('public pages check every 30 minutes', () => {
  assert.equal(updateCheckEveryMs({ streams: 0, connected: 0 }), 30 * 60_000);
});

test('a connected stream drops the timer', () => {
  assert.equal(updateCheckEveryMs({ streams: 1, connected: 1 }), null);
  // Two providers, one of them connected: the connected one's ready covers the page.
  assert.equal(updateCheckEveryMs({ streams: 2, connected: 1 }), null);
});

test('a provider without a connected stream keeps 5 minutes', () => {
  assert.equal(updateCheckEveryMs({ streams: 1, connected: 0 }), 5 * 60_000);
  assert.equal(updateCheckEveryMs({ streams: 2, connected: 0 }), 5 * 60_000);
});

test('a ready checks only when the last check is at least a minute old', () => {
  assert.equal(READY_CHECK_GAP_MS, 60_000);
  assert.equal(readyMayCheck(null, 0), true);
  assert.equal(readyMayCheck(1_000, 1_000 + 59_999), false);
  assert.equal(readyMayCheck(1_000, 1_000 + 60_000), true);
});
