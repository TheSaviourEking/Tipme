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
  stale: false,
  ...over,
});

test('a healthy reserve shows its amount, the alert level and how fresh the reading is', () => {
  assert.deepEqual(reserveView(reading(), NOW), {
    value: '₦50,000',
    hint: 'Alert below ₦1,000 · read 12 min ago',
    status: 'ok',
    stale: false,
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

test('a stale reading says the checks may have stopped, and still shows low or unreadable', () => {
  // The API decides what is stale (one constant, on the server); the view follows it.
  const old = { readAt: '2026-11-01T09:00:00Z', stale: true };
  const ok = reserveView(reading(old), NOW);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.stale, true);
  assert.match(ok.hint, /3 h ago/);
  assert.match(ok.hint, /checks may have stopped/);
  const low = reserveView(
    reading({ ...old, availableMinor: '99999', low: true }),
    NOW,
  );
  assert.equal(low.status, 'low');
  assert.equal(low.stale, true);
  const unreadable = reserveView(
    reading({ ...old, availableMinor: null, low: null }),
    NOW,
  );
  assert.equal(unreadable.status, 'unreadable');
  assert.equal(unreadable.stale, true);
});

test('an old reading from an API that sends no stale flag is not called stale', () => {
  const older = reading({ readAt: '2026-11-01T09:00:00Z' });
  delete older.stale;
  assert.equal(reserveView(older, NOW).stale, false);
});

test('nothing has been read yet', () => {
  assert.deepEqual(reserveView(null, NOW), {
    value: 'Not read yet',
    hint: 'The worker checks every 15 minutes once a payment provider is running.',
    status: 'none',
    stale: false,
  });
});
