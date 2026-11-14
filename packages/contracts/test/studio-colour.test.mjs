import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  AA,
  STUDIO_SCRIM,
  blend,
  contrastRatio,
  deriveStudioPalette,
  hexToOklch,
  isHex,
  oklchToHex,
  paletteFailures,
} from '../dist/index.js';
import { regressions, runs, seed } from './support/pbt.mjs';

const hex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, '0')}`);

const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

test('any brand colour gives a palette where every pair passes AA, light and dark', () => {
  for (const brand of regressions('colour'))
    assert.deepEqual(
      paletteFailures(deriveStudioPalette(brand)),
      [],
      String(brand),
    );
  fc.assert(
    fc.property(hex, fc.option(hex, { nil: undefined }), (a, b) => {
      const p = deriveStudioPalette(b ? [a, b] : [a]);
      assert.deepEqual(paletteFailures(p), []);
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('the engine is deterministic and keeps the brand hue where it can', () => {
  fc.assert(
    fc.property(hex, (a) => {
      const p1 = deriveStudioPalette([a]);
      const p2 = deriveStudioPalette([a]);
      assert.deepEqual(p1, p2);
      const { c, h } = hexToOklch(a);
      if (c >= 0.05)
        assert.ok(
          hueDistance(hexToOklch(p1.light.heading).h, h) <= 6,
          `${a}: heading ${p1.light.heading}`,
        );
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('edge colours', () => {
  for (const a of [
    '#000000',
    '#ffffff',
    '#ffff00',
    '#777777',
    '#00ff00',
    '#0000ff',
    '#f5c400',
    '#e0457b',
  ])
    assert.deepEqual(paletteFailures(deriveStudioPalette([a])), [], a);
});

test('a yellow that cannot carry text becomes an accent with a deeper link shade', () => {
  const p = deriveStudioPalette(['#f5c400']);
  assert.equal(p.notes.light[0].code, 'ACCENT_ONLY');
  assert.ok(contrastRatio(p.light.link, p.light.page) >= 4.5);
  assert.equal(p.light.button, '#f5c400');
});

test('a pink that passes only for large text is LARGE_ONLY', () => {
  assert.equal(
    deriveStudioPalette(['#e0457b']).notes.light[0].code,
    'LARGE_ONLY',
  );
});

test('a brand colour that carries text is used as the link and accent', () => {
  const p = deriveStudioPalette(['#1d4e89']);
  assert.equal(p.light.link, '#1d4e89');
  assert.equal(p.light.accent, '#1d4e89');
  assert.equal(p.light.accentLarge, false);
  assert.deepEqual(p.notes.light, []);
});

test('a near-grey brand colour falls back to neutral shades', () => {
  const p = deriveStudioPalette(['#777777']);
  assert.ok(p.notes.light.some((n) => n.code === 'NEUTRAL_FALLBACK'));
  assert.deepEqual(paletteFailures(p), []);
});

test('the second colour gets its own fill, text on it and a text shade', () => {
  const p = deriveStudioPalette(['#1d4e89', '#f5c400']);
  assert.ok(p.light.second && p.dark.second);
  assert.equal(p.light.second.fill, '#f5c400');
  assert.ok(contrastRatio(p.light.second.onFill, '#f5c400') >= AA.body);
  assert.ok(contrastRatio(p.light.second.text, p.light.page) >= AA.body);
  assert.equal(deriveStudioPalette(['#1d4e89']).light.second, undefined);
});

test('the checker catches a failing pair (not vacuous)', () => {
  const p = deriveStudioPalette(['#1d4e89']);
  p.light.muted = '#9a9a9a';
  assert.match(paletteFailures(p).join('\n'), /light muted on page/);
  const q = deriveStudioPalette(['#1d4e89']);
  q.dark.buttonText = q.dark.button;
  assert.match(paletteFailures(q).join('\n'), /dark buttonText on button/);
});

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

test('the scrim keeps white text readable over a white photo', () => {
  assert.equal(STUDIO_SCRIM.colour, '#000000');
  assert.ok(
    contrastRatio(
      STUDIO_SCRIM.text,
      blend(STUDIO_SCRIM.colour, STUDIO_SCRIM.opacity, '#ffffff'),
    ) >= 4.5,
  ); // #616161: 6.19
});
