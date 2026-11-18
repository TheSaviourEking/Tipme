import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  blend,
  contrastRatio,
  hexToOklch,
  isHex,
  oklchToHex,
} from '../dist/index.js';
import { runs, seed } from './support/pbt.mjs';

const hex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, '0')}`);

test('contrastRatio matches WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#7a32f9', '#ffffff').toFixed(2), '5.75');
  assert.equal(contrastRatio('#ffffff', '#7a32f9').toFixed(2), '5.75');
});

test('OKLCH round-trips sRGB within 1 unit per channel', () => {
  const channels = (h) =>
    [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  fc.assert(
    fc.property(hex, (a) => {
      const back = oklchToHex(hexToOklch(a));
      const d = channels(a).map((v, i) => Math.abs(v - channels(back)[i]));
      assert.ok(Math.max(...d) <= 1, `${a} → ${back}`);
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('oklchToHex gamut-maps by reducing chroma, never failing', () => {
  for (const l of [0, 0.3, 0.6, 0.9, 1])
    assert.ok(isHex(oklchToHex({ l, c: 0.5, h: 140 })));
});

test('isHex accepts only 6-digit lower-case hex', () => {
  assert.equal(isHex('#7a32f9'), true);
  for (const bad of ['#7A32F9', '7a32f9', '#7a3', '#7a32f9ff', 'red', ''])
    assert.equal(isHex(bad), false, bad);
});

test('blend mixes a colour over another at an opacity', () => {
  assert.equal(blend('#000000', 0.62, '#ffffff'), '#616161');
  assert.equal(blend('#000000', 0, '#ffffff'), '#ffffff');
});
