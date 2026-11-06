import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupDesigns } from '../src/lib/qr-groups.ts';

const item = (id, kind) => ({
  id,
  name: id,
  kind,
  locked: true,
  thumb: '',
  note: null,
});

test('designs keep the API order inside Patterns, Cards and Photo', () => {
  const items = [
    item('heart', 'style'),
    item('jewel', 'style'),
    item('mosaic', 'photo'),
    item('indigo', 'card'),
    item('woven', 'card'),
    item('naira', 'style'),
  ];
  const groups = groupDesigns(items);
  assert.deepEqual(
    groups.map((g) => [g.id, g.legend, g.items.map((i) => i.id)]),
    [
      ['patterns', 'Patterns', ['heart', 'jewel', 'naira']],
      ['cards', 'Cards', ['indigo', 'woven']],
      ['photo', 'Photo', ['mosaic']],
    ],
  );
  // Every design is listed exactly once.
  assert.equal(
    groups.reduce((n, g) => n + g.items.length, 0),
    items.length,
  );
});

test('an unknown kind joins Patterns; an empty group is dropped', () => {
  const groups = groupDesigns([
    item('heart', 'style'),
    item('future', 'hologram'),
    item('mosaic', 'photo'),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.items.map((i) => i.id)]),
    [
      ['patterns', ['heart', 'future']],
      ['photo', ['mosaic']],
    ],
  );
  assert.deepEqual(groupDesigns([]), []);
});
