import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitWithin } from '../src/lib/shrink-photo.ts';

test('a photo is scaled down to fit 1024 px on its longest side, never up', () => {
  assert.deepEqual(fitWithin(4032, 3024, 1024), { width: 1024, height: 768 });
  assert.deepEqual(fitWithin(3024, 4032, 1024), { width: 768, height: 1024 });
  assert.deepEqual(fitWithin(800, 600, 1024), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(5000, 10, 1024), { width: 1024, height: 2 });
});
