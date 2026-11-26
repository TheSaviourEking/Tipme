import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLivePresence, livePresence } from '../src/lib/live-presence.ts';

// The in-page registry the live providers report to, so the update notice knows whether a
// stream is connected without a request of its own (addendum §3.5).
test('join, status and leave keep the counts', () => {
  const presence = createLivePresence();
  assert.deepEqual(presence.snapshot(), { streams: 0, connected: 0 });
  const a = presence.join();
  const b = presence.join();
  assert.deepEqual(presence.snapshot(), { streams: 2, connected: 0 });
  a.status('connecting');
  a.status('connected');
  assert.deepEqual(presence.snapshot(), { streams: 2, connected: 1 });
  b.status('connected');
  assert.deepEqual(presence.snapshot(), { streams: 2, connected: 2 });
  b.status('polling');
  assert.deepEqual(presence.snapshot(), { streams: 2, connected: 1 });
  b.leave();
  assert.deepEqual(presence.snapshot(), { streams: 1, connected: 1 });
  a.status('disabled');
  assert.deepEqual(presence.snapshot(), { streams: 1, connected: 0 });
});

test('status changes, joins and leaves reach subscribers', () => {
  const presence = createLivePresence();
  const events = [];
  const off = presence.subscribe((event) => events.push(event));
  const a = presence.join();
  a.status('connecting');
  a.status('connecting'); // no change: nothing to tell
  a.status('connected');
  a.leave();
  assert.deepEqual(events, ['status', 'status', 'status', 'status']);
  off();
  presence.join();
  assert.equal(events.length, 4);
});

test('ready reaches subscribers', () => {
  const presence = createLivePresence();
  const events = [];
  presence.subscribe((event) => events.push(event));
  const a = presence.join();
  events.length = 0;
  a.ready();
  a.ready();
  assert.deepEqual(events, ['ready', 'ready']);
});

test('a provider that left no longer counts as connected', () => {
  const presence = createLivePresence();
  const events = [];
  const a = presence.join();
  a.status('connected');
  a.leave();
  presence.subscribe((event) => events.push(event));
  // A late callback from a stream that already left changes nothing and says nothing.
  a.status('connected');
  a.ready();
  a.leave();
  assert.deepEqual(presence.snapshot(), { streams: 0, connected: 0 });
  assert.deepEqual(events, []);
});

test('the page has one registry', () => {
  assert.deepEqual(livePresence.snapshot(), { streams: 0, connected: 0 });
});
