import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVE_CONTROL_TYPES,
  LIVE_RECIPIENT_TYPES,
  LIVE_SERVER_TYPES,
  LIVE_STAFF_TYPES,
  liveChannel,
  parseLiveMessage,
} from '../dist/index.js';

const USER = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4';
const PROFILE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('liveChannel uses the queue prefix', () => {
  assert.equal(liveChannel('tipme'), 'tipme:live:v1');
});

test('parseLiveMessage accepts each documented target', () => {
  const lines = [
    { to: { user: USER }, type: 'profile.changed' },
    { to: { profile: PROFILE }, type: 'tips.changed' },
    { to: { all: true }, type: 'withdrawals.changed' },
    { to: { staff: 'issues.view' }, type: 'ops.issues.changed' },
  ];
  for (const line of lines) {
    assert.deepEqual(parseLiveMessage(JSON.stringify(line)), line);
  }
});

test('parseLiveMessage rejects junk without throwing', () => {
  const junk = [
    'nope',
    '{}',
    JSON.stringify({ to: { user: USER }, type: 'tips.exploded' }),
    JSON.stringify({ to: { user: USER }, type: 'tips.changed', amount: 1 }),
    JSON.stringify({ to: { user: 'not-a-uuid' }, type: 'tips.changed' }),
    JSON.stringify({
      to: { staff: 'payouts.resolve' },
      type: 'ops.issues.changed',
    }),
  ];
  for (const raw of junk) {
    assert.equal(parseLiveMessage(raw), null, raw);
  }
});

test('control types are disjoint from event types', () => {
  const events = new Set([
    ...LIVE_RECIPIENT_TYPES,
    ...LIVE_STAFF_TYPES,
    ...LIVE_SERVER_TYPES,
  ]);
  for (const control of LIVE_CONTROL_TYPES) {
    assert.equal(events.has(control), false, control);
  }
});
