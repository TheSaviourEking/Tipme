import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as claimMoment from '../src/lib/claim-moment.ts';

const {
  CLAIM_LANDED_MS,
  CLAIM_TAP_ARMED_MS,
  claimBuzz,
  endsClaimMoment,
  markClaimed,
  takeClaimed,
} = claimMoment;

function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

const throwing = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

test('the moment never hands over by itself: there is no duration to wait out', () => {
  // Owner, 15 Nov 2026: it stays until they move on.
  assert.equal('CLAIM_MOMENT_MS' in claimMoment, false);
});

test('Escape and Enter end it; other keys (Tab, letters, a held key) do not', () => {
  assert.equal(endsClaimMoment({ kind: 'key', key: 'Escape' }), true);
  assert.equal(endsClaimMoment({ kind: 'key', key: 'Enter' }), true);
  for (const key of ['Tab', 'a', ' ', 'Shift', 'ArrowDown', 'Meta'])
    assert.equal(endsClaimMoment({ kind: 'key', key }), false, key);
  // A held Enter from the claim form repeats into the moment; that is not a choice to move on.
  assert.equal(
    endsClaimMoment({ kind: 'key', key: 'Enter', repeat: true }),
    false,
  );
});

test('the tap that brought them here does not end it; a tap after the card lands does', () => {
  assert.ok(CLAIM_TAP_ARMED_MS > CLAIM_LANDED_MS);
  assert.equal(endsClaimMoment({ kind: 'tap', sinceShownMs: 0 }), false);
  assert.equal(
    endsClaimMoment({ kind: 'tap', sinceShownMs: CLAIM_LANDED_MS }),
    false,
  );
  assert.equal(
    endsClaimMoment({ kind: 'tap', sinceShownMs: CLAIM_TAP_ARMED_MS - 1 }),
    false,
  );
  assert.equal(
    endsClaimMoment({ kind: 'tap', sinceShownMs: CLAIM_TAP_ARMED_MS }),
    true,
  );
  assert.equal(endsClaimMoment({ kind: 'tap', sinceShownMs: 60_000 }), true);
});

test('takeClaimed is true once after markClaimed for the same handle, then false', () => {
  const storage = memoryStorage();
  markClaimed('ada_ok', storage);
  assert.equal(takeClaimed('ada_ok', storage), true);
  assert.equal(takeClaimed('ada_ok', storage), false);
  // The marker is deleted on first read and holds the handle only.
  assert.equal(storage.items.size, 0);
});

test('the marker holds the handle and nothing else', () => {
  const storage = memoryStorage();
  markClaimed('ada_ok', storage);
  assert.deepEqual([...storage.items.values()], ['ada_ok']);
});

test('another handle, or no mark, is false', () => {
  const storage = memoryStorage();
  assert.equal(takeClaimed('ada_ok', storage), false);
  markClaimed('ada_ok', storage);
  assert.equal(takeClaimed('someone_else', storage), false);
  // A wrong handle still clears the marker, so it cannot replay later.
  assert.equal(takeClaimed('ada_ok', storage), false);
});

test('a storage that throws never throws out of mark or take', () => {
  assert.doesNotThrow(() => markClaimed('ada_ok', throwing));
  assert.equal(takeClaimed('ada_ok', throwing), false);
});

test('without any storage there is no moment and nothing throws', () => {
  assert.doesNotThrow(() => markClaimed('ada_ok', undefined));
  assert.equal(takeClaimed('ada_ok', undefined), false);
});

test('claimBuzz vibrates 30 ms, and not with reduced motion or without vibrate', () => {
  const calls = [];
  const nav = { vibrate: (pattern) => (calls.push(pattern), true) };
  claimBuzz(nav, false);
  assert.deepEqual(calls, [30]);
  claimBuzz(nav, true);
  assert.deepEqual(calls, [30]);
  assert.doesNotThrow(() => claimBuzz(undefined, false));
  assert.doesNotThrow(() => claimBuzz({}, false));
  assert.doesNotThrow(() =>
    claimBuzz(
      {
        vibrate() {
          throw new Error('blocked');
        },
      },
      false,
    ),
  );
});
