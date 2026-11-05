import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextActive } from '../src/lib/listbox-navigation.ts';

test('arrow keys move one option and stop at the ends', () => {
  assert.equal(nextActive(-1, 'ArrowDown', 5), 0);
  assert.equal(nextActive(0, 'ArrowDown', 5), 1);
  assert.equal(nextActive(4, 'ArrowDown', 5), 4);
  assert.equal(nextActive(3, 'ArrowUp', 5), 2);
  assert.equal(nextActive(0, 'ArrowUp', 5), 0);
  assert.equal(nextActive(-1, 'ArrowUp', 5), 0);
});

test('Home and End jump to the first and last', () => {
  assert.equal(nextActive(3, 'Home', 5), 0);
  assert.equal(nextActive(-1, 'Home', 5), 0);
  assert.equal(nextActive(1, 'End', 5), 4);
  assert.equal(nextActive(-1, 'End', 5), 4);
});

test('an empty list never has an active option', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'])
    assert.equal(nextActive(-1, key, 0), -1, key);
});
