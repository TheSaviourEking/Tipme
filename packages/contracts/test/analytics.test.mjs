import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANALYTICS_CLIENT_EVENTS,
  ANALYTICS_SERVER_EVENTS,
  analyticsEventSchema,
} from '../dist/index.js';

const flowId = '0192f0c4-7a3e-7b1c-9d2e-3f4a5b6c7d8e';
const ok = (extra) =>
  analyticsEventSchema.safeParse({ name: 'profile_viewed', flowId, ...extra })
    .success;

test('allow-listed events with allow-listed properties pass', () => {
  assert.equal(
    ok({ surface: 'profile', channel: 'qr', handle: 'tobi', returning: true }),
    true,
  );
  for (const name of ANALYTICS_CLIENT_EVENTS)
    assert.equal(
      analyticsEventSchema.safeParse({ name, flowId }).success,
      true,
      name,
    );
});

test('anything that could carry personal data is refused (Review Focus 4)', () => {
  assert.equal(ok({ message: 'x' }), false, 'free text');
  assert.equal(ok({ phone: '+2348031234567' }), false, 'phone');
  assert.equal(ok({ handle: '0803 123' }), false, 'spaces');
  assert.equal(ok({ handle: 'a'.repeat(31) }), false, 'too long');
  assert.equal(ok({ channel: 'https://evil.example/?q=me' }), false, 'url');
  assert.equal(ok({ surface: 'anything' }), false);
  assert.equal(ok({ flowId: 'not-a-uuid' }), false);
  assert.equal(
    analyticsEventSchema.safeParse({ name: 'whatever', flowId }).success,
    false,
  );
});

test('server-only outcomes cannot be sent by a browser', () => {
  for (const name of ANALYTICS_SERVER_EVENTS)
    assert.equal(
      analyticsEventSchema.safeParse({ name, flowId }).success,
      false,
      name,
    );
  assert.ok(ANALYTICS_SERVER_EVENTS.includes('tip_completed'));
});
