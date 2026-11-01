import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSwitchView } from '../src/lib/live-switch-view.ts';

const history = (live, version = 'abcdef1234567890') => ({
  live,
  provider: 'bachs-live',
  version,
  switchedAt: '2026-11-01T09:00:00.000Z',
});
const now = (live, checkout = 'named', handles = ['ada']) => ({
  live,
  provider: 'bachs-live',
  checkout,
  handles,
});

test('current state comes from the API serving now; the record is history', () => {
  const view = liveSwitchView(now(true), history(true));
  assert.equal(view.current, 'Live payments: on. Checkout open to @ada only.');
  assert.equal(
    view.history,
    'Last recorded change: on, 1 Nov 2026, 10:00, by abcdef1',
  );
  assert.equal(view.disagrees, false);
  assert.equal(view.testMoney, false);
});

test('a record saying off while the API is on is flagged, and never reads as test money', () => {
  const view = liveSwitchView(now(true), history(false));
  assert.match(view.current, /^Live payments: on/);
  assert.equal(view.disagrees, true);
  assert.equal(view.testMoney, false);
  // A live copy whose record failed: no history, and still on.
  const none = liveSwitchView(now(true), null);
  assert.equal(none.disagrees, true);
  assert.equal(none.testMoney, false);
});

test('checkout wording: nobody, everyone, off', () => {
  assert.equal(
    liveSwitchView(now(true, 'nobody', []), history(true)).current,
    'Live payments: on. Checkout open to nobody yet.',
  );
  assert.equal(
    liveSwitchView(now(true, 'everyone', []), history(true)).current,
    'Live payments: on. Checkout open to everyone.',
  );
  const off = liveSwitchView(now(false, 'closed', []), null);
  assert.equal(off.current, 'Live payments: off. Checkout closed.');
  assert.equal(off.history, null);
  assert.equal(off.disagrees, false);
  assert.equal(off.testMoney, false);
});

test('"test money" only where the API says it is on a test provider; an older API says nothing', () => {
  const test_ = liveSwitchView(
    { live: false, provider: 'mock', checkout: 'test', handles: [] },
    null,
  );
  assert.equal(test_.testMoney, true);
  assert.equal(test_.current, 'Live payments: off. Test money only.');
  const older = liveSwitchView(undefined, history(true));
  assert.equal(older.testMoney, false);
  assert.equal(older.current, null);
});
