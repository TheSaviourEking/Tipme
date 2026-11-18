import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  PHOTO_ACCENT_BAND,
  STUDIO_ACCENTS,
  STUDIO_STYLE_IDS,
  accentValues,
  contrastRatio,
  hexToOklch,
  photoAccentNotice,
  photoAccentOf,
  photoAccentSchema,
  pickPhotoAccent,
  studioContrastPairs,
  studioTokens,
} from '../dist/index.js';
import { runs, seed } from './support/pbt.mjs';

// "From your photo" (styles spec §6): the server samples up to five colours from the avatar, and
// this picks the accent. Every colour here is generated; no photo is involved.

const MODES = ['light', 'dark'];

const hex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, '0')}`);

const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Every pair all nine styles draw with these values, failing ones only. */
const failures = (values) => {
  const out = [];
  for (const mode of MODES)
    for (const style of STUDIO_STYLE_IDS)
      for (const p of studioContrastPairs(style, values[mode], mode)) {
        const ratio = contrastRatio(p.fg, p.bg);
        if (ratio < p.min)
          out.push(`${style} ${mode} ${p.name} ${ratio.toFixed(2)}`);
      }
  return out;
};

const lab = (h) => {
  const { l, c, h: hue } = hexToOklch(h);
  const r = (hue * Math.PI) / 180;
  return [l, c * Math.cos(r), c * Math.sin(r)];
};
const nearest = (h) =>
  Object.keys(STUDIO_ACCENTS)
    .map((id) => [
      id,
      Math.hypot(
        ...lab(h).map((v, i) => v - lab(STUDIO_ACCENTS[id].light.fill)[i]),
      ),
    ])
    .sort((a, b) => a[1] - b[1])[0][0];

test('near-greys and low-chroma skin oranges are dropped', () => {
  // A grey, a near-grey and two skin tones, then one blue: the blue is the accent.
  const picked = pickPhotoAccent([
    '#808080',
    '#8a8580',
    '#c68642',
    '#e0ac69',
    '#2f6fd6',
  ]);
  assert.ok(!('failed' in picked), JSON.stringify(picked));
  assert.ok(
    hueDistance(hexToOklch(picked.light.fill).h, hexToOklch('#2f6fd6').h) < 4,
  );
  // Nothing under OKLCH chroma 0.04 is ever chosen.
  fc.assert(
    fc.property(fc.array(hex, { minLength: 1, maxLength: 5 }), (colours) => {
      const p = pickPhotoAccent(colours);
      if ('failed' in p) return;
      const source = colours.find(
        (c) =>
          hexToOklch(c).c >= 0.04 &&
          hueDistance(hexToOklch(c).h, hexToOklch(p.light.fill).h) < 6,
      );
      assert.ok(source, 'the accent comes from one of the colours');
    }),
    { numRuns: runs(500), seed: seed() },
  );
  for (const greys of [['#808080'], ['#777777', '#7a7674', '#f0f0f0']])
    assert.equal(pickPhotoAccent(greys).failed, true, String(greys));
});

test('fills are clamped to L .45–.55 light and .75–.82 dark with chroma at most .16, keeping hue', () => {
  assert.deepEqual(PHOTO_ACCENT_BAND, {
    light: [0.45, 0.55],
    dark: [0.75, 0.82],
    chroma: 0.16,
    grey: 0.04,
  });
  // Very light, very dark and very vivid colours, at many hues.
  const inputs = [
    '#ff0000',
    '#00ff40',
    '#2040ff',
    '#ffb0d8',
    '#200010',
    '#a0ff00',
    '#00ffff',
    '#ff00ff',
    '#3a0ca3',
    '#0b3d2e',
  ];
  for (const colour of inputs) {
    const p = pickPhotoAccent([colour]);
    assert.ok(!('failed' in p), `${colour} failed`);
    const hue = hexToOklch(colour).h;
    for (const [mode, [lo, hi]] of [
      ['light', PHOTO_ACCENT_BAND.light],
      ['dark', PHOTO_ACCENT_BAND.dark],
    ]) {
      const fill = hexToOklch(p[mode].fill);
      // A hex is 8 bits a channel: allow its rounding.
      assert.ok(
        fill.l >= lo - 0.005 && fill.l <= hi + 0.005,
        `${colour} ${mode} L ${fill.l}`,
      );
      assert.ok(fill.c <= 0.165, `${colour} ${mode} C ${fill.c}`);
      assert.ok(
        hueDistance(fill.h, hue) < 4,
        `${colour} ${mode} hue ${fill.h} vs ${hue}`,
      );
    }
  }
});

test('the text value reaches 4.5:1 on every style’s page and card in that mode, Classic’s included; the ring reaches 3:1', () => {
  for (const colour of [
    '#a2461e',
    '#2f6fd6',
    '#0b7a4b',
    '#d81b60',
    '#7b1fa2',
  ]) {
    const p = pickPhotoAccent([colour]);
    assert.ok(!('failed' in p), colour);
    for (const mode of MODES)
      for (const style of STUDIO_STYLE_IDS) {
        const n = (
          studioContrastPairs(style, p[mode], mode).find(
            (x) => x.name === 'accText on bg',
          ) ?? {}
        ).bg;
        assert.ok(n, `${style} draws accText on bg`);
        const pairs = studioContrastPairs(style, p[mode], mode);
        for (const pair of pairs.filter((x) => x.fg === p[mode].text))
          assert.ok(
            contrastRatio(pair.fg, pair.bg) >= pair.min,
            `${colour} ${style} ${mode} ${pair.name}`,
          );
        const ring = pairs.filter((x) =>
          x.name.startsWith('focus ring (accText)'),
        );
        assert.equal(ring.length, 2);
        for (const r of ring) assert.ok(contrastRatio(r.fg, r.bg) >= 3);
      }
    assert.deepEqual(failures(p), [], colour);
  }
  // Classic's four light surfaces and three dark ones (§7.3) are among those proved.
  const p = pickPhotoAccent(['#a2461e']);
  for (const s of ['#f3f2ee', '#fffefa', '#eeede8', '#ffffff'])
    assert.ok(contrastRatio(p.light.text, s) >= 4.5, s);
  for (const s of ['#141210', '#1e1b18', '#2a2622'])
    assert.ok(contrastRatio(p.dark.text, s) >= 4.5, s);
});

test('with no passing candidate it falls back to the nearest curated accent by OKLab', () => {
  // Greys only: Ink (§7.1's rule for greys).
  assert.deepEqual(pickPhotoAccent(['#808080', '#a0a0a0']), {
    failed: true,
    fallback: 'ink',
  });
  // Skin tones only: the curated accent nearest the most dominant one.
  for (const skin of [['#c68642', '#e0ac69'], ['#8d5524'], ['#e0ac69']])
    assert.deepEqual(pickPhotoAccent(skin), {
      failed: true,
      fallback: nearest(skin[0]),
    });
  assert.deepEqual(pickPhotoAccent([]), { failed: true, fallback: 'ink' });
  // Not a colour (never from our sampler, but never trusted either).
  assert.deepEqual(pickPhotoAccent(['red', '#12345']), {
    failed: true,
    fallback: 'ink',
  });
});

test('the same colours always give the same result', () => {
  const colours = ['#c68642', '#2f6fd6', '#808080', '#0b7a4b', '#e53935'];
  const first = pickPhotoAccent(colours);
  for (let i = 0; i < 20; i += 1)
    assert.deepEqual(pickPhotoAccent([...colours]), first);
  fc.assert(
    fc.property(fc.array(hex, { maxLength: 5 }), (c) =>
      assert.deepEqual(pickPhotoAccent(c), pickPhotoAccent([...c])),
    ),
    { numRuns: runs(300), seed: seed() },
  );
});

test('for any input colours it returns a passing pair or the fallback', () => {
  fc.assert(
    fc.property(fc.array(hex, { maxLength: 8 }), (colours) => {
      const p = pickPhotoAccent(colours);
      if ('failed' in p) {
        assert.equal(p.failed, true);
        assert.ok(Object.keys(STUDIO_ACCENTS).includes(p.fallback));
        return;
      }
      assert.deepEqual(failures(p), []);
      for (const mode of MODES)
        for (const v of Object.values(p[mode]))
          assert.match(v, /^#[0-9a-f]{6}$/);
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('a stored photo accent is read only when valid and for the avatar it was made from', () => {
  const values = pickPhotoAccent(['#2f6fd6']);
  const stored = { source: 'avatar', avatarVersion: 3, ...values };
  assert.equal(photoAccentSchema.safeParse(stored).success, true);
  assert.deepEqual(photoAccentOf(stored, { avatarVersion: 3 }), values);
  // A newer avatar, or none: never a stale accent.
  assert.equal(photoAccentOf(stored, { avatarVersion: 4 }), null);
  assert.equal(photoAccentOf(stored, null), null);
  const failed = { failed: true, fallback: 'rose' };
  assert.deepEqual(photoAccentOf(failed, { avatarVersion: 9 }), failed);
  assert.equal(photoAccentOf(failed, null), null);
  // Anything else is nothing: no stored text reaches CSS.
  for (const bad of [
    null,
    'x',
    { ...stored, light: { ...stored.light, fill: 'red;}' } },
    { ...stored, source: 'cover' },
    { failed: true, fallback: 'photo' },
    { failed: true, fallback: 'teal' },
    { ...stored, extra: 1 },
  ])
    assert.equal(photoAccentOf(bad, { avatarVersion: 3 }), null);
});

test('tokens and accent values use the photo values, a failed accent its fallback, and nothing the default', () => {
  const values = pickPhotoAccent(['#2f6fd6']);
  assert.deepEqual(accentValues('linen', 'photo', 'dark', values), values.dark);
  const failed = { failed: true, fallback: 'rose' };
  assert.deepEqual(
    accentValues('linen', 'photo', 'light', failed),
    STUDIO_ACCENTS.rose.light,
  );
  assert.deepEqual(
    studioTokens('journal', 'photo', failed),
    studioTokens('journal', 'rose'),
  );
  assert.deepEqual(
    studioTokens('journal', 'photo', null),
    studioTokens('journal', null),
  );
  assert.equal(
    studioTokens('stage', 'photo', values).dark.acc,
    values.dark.fill,
  );
  // A photo accent only ever applies to `accent: 'photo'`.
  assert.deepEqual(
    studioTokens('clear', 'green', values),
    studioTokens('clear', 'green'),
  );
});

test('the editor’s sentence names the fallback', () => {
  assert.equal(
    photoAccentNotice({ failed: true, fallback: 'coral' }),
    "Your photo's colours didn't pass our contrast check, so your page uses Coral.",
  );
  assert.equal(photoAccentNotice(pickPhotoAccent(['#2f6fd6'])), null);
  assert.equal(photoAccentNotice(null), null);
});
