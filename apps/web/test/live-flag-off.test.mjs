import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstReadPhase } from '../src/lib/first-read.ts';
import { liveProviderEnabled } from '../src/lib/live-enabled.ts';

// With LIVE_UPDATES_ENABLED off, a page must behave exactly as before the feature: no stream, no
// probe, and every panel reads at once (review M3; re-review item 1).

const STATUSES = ['idle', 'connecting', 'connected', 'polling', 'disabled'];

test('the shell opens a stream only when the profile says live updates are on', () => {
  assert.equal(
    liveProviderEnabled({ profile: null, liveUpdates: true }),
    false,
  );
  assert.equal(
    liveProviderEnabled({ profile: { handle: 'ada' }, liveUpdates: false }),
    false,
  );
  assert.equal(
    liveProviderEnabled({ profile: { handle: 'ada' }, liveUpdates: true }),
    true,
  );
});

test('with live updates off, every panel reads at once, whatever the status', () => {
  for (const status of STATUSES)
    for (const supported of [true, false])
      assert.equal(
        firstReadPhase({ enabled: false, supported, status }),
        'free',
        `${status} ${supported}`,
      );
});

test('without EventSource, every panel reads at once', () => {
  for (const status of STATUSES)
    assert.equal(
      firstReadPhase({ enabled: true, supported: false, status }),
      'free',
      status,
    );
});

test('with live updates on, panels wait only while the stream connects', () => {
  const phase = (status) =>
    firstReadPhase({ enabled: true, supported: true, status });
  assert.equal(phase('idle'), 'hold');
  assert.equal(phase('connecting'), 'hold');
  assert.equal(phase('connected'), 'connected');
  assert.equal(phase('polling'), 'free');
  assert.equal(phase('disabled'), 'free');
});
