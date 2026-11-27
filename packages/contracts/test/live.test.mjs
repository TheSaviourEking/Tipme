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

test('the drain retry range is 1 to 10 s, shared by the hub and the browser', async () => {
  const { LIVE_DRAIN_RETRY_MS } = await import('../dist/index.js');
  assert.deepEqual(LIVE_DRAIN_RETRY_MS, { min: 1000, max: 10_000 });
});

test('a staff target may name a list of permissions', () => {
  assert.notEqual(
    parseLiveMessage(
      '{"to":{"staff":["issues.view","providers.manage"]},"type":"ops.providers.changed"}',
    ),
    null,
  );
  for (const staff of [[], ['switches.manage'], ['issues.view', 'issues.view']])
    assert.equal(
      parseLiveMessage(
        JSON.stringify({ to: { staff }, type: 'ops.providers.changed' }),
      ),
      null,
      JSON.stringify(staff),
    );
});

test('every staff permission a target names parses as one permission', async () => {
  const { LIVE_STAFF_PERMISSIONS } = await import('../dist/index.js');
  assert.deepEqual(
    [...LIVE_STAFF_PERMISSIONS],
    ['issues.view', 'announcements.send', 'providers.manage'],
  );
  for (const staff of LIVE_STAFF_PERMISSIONS)
    assert.notEqual(
      parseLiveMessage(
        JSON.stringify({ to: { staff }, type: 'ops.issues.changed' }),
      ),
      null,
      staff,
    );
});

test('a tip target needs a uuid and only tip.changed is a tip type', async () => {
  const { LIVE_TIP_TYPES, tipChanged } = await import('../dist/index.js');
  const TIP = '9b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
  assert.deepEqual([...LIVE_TIP_TYPES], ['tip.changed']);
  const line = { to: { tip: TIP }, type: 'tip.changed' };
  assert.deepEqual(parseLiveMessage(JSON.stringify(line)), line);
  assert.deepEqual(tipChanged(TIP), line);
  const refused = [
    // A tip target needs a uuid.
    { to: { tip: 'not-a-uuid' }, type: 'tip.changed' },
    { to: { tip: TIP, user: USER }, type: 'tip.changed' },
    // A tip target carries tip.changed and nothing else (ruling L-R4): a publisher bug must
    // never put a recipient, staff or server type on a public stream.
    { to: { tip: TIP }, type: 'tips.changed' },
    { to: { tip: TIP }, type: 'ops.issues.changed' },
    { to: { tip: TIP }, type: 'sessions.changed' },
    // And tip.changed goes to a tip target only.
    { to: { user: USER }, type: 'tip.changed' },
    { to: { profile: PROFILE }, type: 'tip.changed' },
    { to: { all: true }, type: 'tip.changed' },
    { to: { staff: 'any' }, type: 'tip.changed' },
  ];
  for (const message of refused)
    assert.equal(
      parseLiveMessage(JSON.stringify(message)),
      null,
      JSON.stringify(message),
    );
  // Disjoint from the control types, like every event type.
  for (const control of LIVE_CONTROL_TYPES)
    assert.equal(LIVE_TIP_TYPES.includes(control), false, control);
});
