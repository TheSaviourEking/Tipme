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
