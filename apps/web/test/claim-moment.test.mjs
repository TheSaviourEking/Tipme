import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAIM_MOMENT_MS,
  claimBuzz,
  markClaimed,
  takeClaimed,
} from '../src/lib/claim-moment.ts';

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

test('the moment lasts 1.6 seconds', () => {
  assert.equal(CLAIM_MOMENT_MS, 1600);
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
