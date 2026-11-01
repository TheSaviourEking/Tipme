import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reserveView } from '../src/lib/payment-reserve.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const reading = (over = {}) => ({
  provider: 'bachs-live',
  currency: 'NGN',
  availableMinor: '5000000',
  thresholdMinor: '100000',
  low: false,
  readAt: '2026-11-01T11:48:00Z',
  ...over,
});

test('a healthy reserve shows its amount, the alert level and how fresh the reading is', () => {
  assert.deepEqual(reserveView(reading(), NOW), {
    value: '₦50,000',
    hint: 'Alert below ₦1,000 · read 12 min ago',
    status: 'ok',
  });
});

test('a low reserve says so and still shows the amount', () => {
  const view = reserveView(
    reading({ availableMinor: '99999', low: true }),
    NOW,
  );
  assert.equal(view.value, '₦999.99');
  assert.equal(view.status, 'low');
});

test('a reserve that could not be read shows no amount', () => {
  const view = reserveView(reading({ availableMinor: null, low: null }), NOW);
  assert.equal(view.value, 'Can’t be read');
  assert.equal(view.status, 'unreadable');
  assert.match(view.hint, /read 12 min ago/);
});

test('an old reading says the checks may have stopped', () => {
  const view = reserveView(reading({ readAt: '2026-11-01T09:00:00Z' }), NOW);
  assert.equal(view.status, 'stale');
  assert.match(view.hint, /3 h ago/);
  assert.match(view.hint, /checks may have stopped/);
});

test('nothing has been read yet', () => {
  assert.deepEqual(reserveView(null, NOW), {
    value: 'Not read yet',
    hint: 'The worker checks every 15 minutes once a payment provider is running.',
    status: 'none',
  });
});
