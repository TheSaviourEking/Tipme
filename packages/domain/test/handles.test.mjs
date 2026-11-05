import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isReservedHandle,
  normaliseHandle,
  RESERVED_HANDLES,
} from '../dist/index.js';

test('handles are lower-case letters, digits and underscores, 3–30 long', () => {
  assert.equal(normaliseHandle('Kemi_1'), 'kemi_1');
  assert.equal(normaliseHandle('  Tobi '), 'tobi');
  for (const bad of ['ab', 'a-b', 'a'.repeat(31), 'kémi', 'a b', ''])
    assert.equal(normaliseHandle(bad), null, bad);
  assert.equal(normaliseHandle('a'.repeat(30)), 'a'.repeat(30));
});

test('handles that clash with TipMe pages are reserved', () => {
  for (const reserved of [
    'dashboard',
    'admin',
    'tipme',
    'signin',
    'support',
    'mock_checkout',
  ])
    assert.equal(isReservedHandle(reserved), true, reserved);
  assert.equal(isReservedHandle('kemi'), false);
  assert.ok(RESERVED_HANDLES.length >= 20);
});

// The /pro page claims this address (owner, 3 Nov 2026).
test('pro is reserved for the Pro page', () => {
  assert.equal(isReservedHandle('pro'), true);
});

// The handles TipMe's own pages show as examples (Home, Pro, the postcards) are reserved, so a
// visitor who types a printed address never lands on a stranger's live page (owner, 5 Nov 2026).
// The seeded demo pages (ada, tobi) are inserted directly and keep working at /@handle.
test('every example handle shown on the site is reserved', () => {
  for (const example of [
    'ada',
    'adacuts',
    'adaedits',
    'adaokafor',
    'tobi',
    'zainab',
  ])
    assert.equal(isReservedHandle(example), true, example);
  assert.equal(isReservedHandle('Zainab'), true);
});

test('the reserved list stays alphabetical, so a duplicate or a misfile is easy to see', () => {
  const sorted = [...RESERVED_HANDLES].sort();
  assert.deepEqual([...RESERVED_HANDLES], sorted);
  assert.equal(new Set(RESERVED_HANDLES).size, RESERVED_HANDLES.length);
});
