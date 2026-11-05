import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isReservedHandle,
  normaliseHandle,
  RESERVED_HANDLES,
  reservationKey,
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

// Staff reservations are stored and compared by one key, so names that differ only by case or by
// '-'/'_' are one reservation, exactly as isReservedHandle folds the built-in list.
test('reservationKey folds case and hyphens into one key', () => {
  for (const raw of ['MTN', 'mtn', ' Mtn '])
    assert.equal(reservationKey(raw), 'mtn', raw);
  assert.equal(reservationKey('how-it-works'), 'how_it_works');
  assert.equal(reservationKey('HOW-IT-WORKS'), 'how_it_works');
  assert.equal(reservationKey('Kemi_NG'), 'kemi_ng');
});

test('reservationKey refuses what can never be a handle', () => {
  for (const bad of ['ab', 'a'.repeat(31), 'kemi!', '', '   ', 'kémi'])
    assert.equal(reservationKey(bad), null, JSON.stringify(bad));
});

test('isReservedHandle is unchanged', () => {
  for (const word of ['admin', 'pro', 'how-it-works', 'how_it_works', 'ADMIN'])
    assert.equal(isReservedHandle(word), true, word);
  assert.equal(isReservedHandle('kemi'), false);
});
