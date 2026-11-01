import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSwitchText } from '../src/lib/live-switch-view.ts';

test('on: since when, and by which version', () => {
  assert.equal(
    liveSwitchText({
      live: true,
      provider: 'bachs-live',
      version: 'abcdef1234567890',
      switchedAt: '2026-11-01T09:00:00.000Z',
    }),
    'Live payments: on since 1 Nov 2026, 10:00, by abcdef1',
  );
});

test('off after being on says so, and when', () => {
  assert.equal(
    liveSwitchText({
      live: false,
      provider: 'bachs-live',
      version: 'unknown',
      switchedAt: '2026-11-01T23:30:00.000Z',
    }),
    'Live payments: off since 2 Nov 2026, 00:30, by unknown',
  );
});

test('never switched, or an older API that sends nothing: off', () => {
  for (const value of [null, undefined])
    assert.equal(liveSwitchText(value), 'Live payments: off');
});
