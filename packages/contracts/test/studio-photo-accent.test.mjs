import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  PHOTO_ACCENT_BAND,
  STUDIO_ACCENTS,
  nearestCuratedAccent,
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
  // The nearest curated accent by OKLab; a near-grey is Ink (§7.1's rule).
  for (const colour of ['#a2461e', '#2f6fd6', '#0b7a4b', '#d81b60', '#f5c400'])
    assert.equal(nearestCuratedAccent(colour), nearest(colour), colour);
  assert.equal(nearestCuratedAccent('#808080'), 'ink');
  // Greys only: nothing survives the filters, so Ink.
  assert.deepEqual(pickPhotoAccent(['#808080', '#a0a0a0']), {
    failed: true,
    fallback: 'ink',
  });
  // Skin tones only: dropped colours never choose the fallback, so Ink too, whatever the skin.
  for (const skin of [['#c68642', '#e0ac69'], ['#8d5524'], ['#e0ac69']])
    assert.deepEqual(pickPhotoAccent(skin), { failed: true, fallback: 'ink' });
});

// Monk Skin Tone scale 1–10, common skin palettes, warm-lit and flushed skin as photos show it
// (the reviewer's samples). Every one must be dropped, light or deep alike.
const SKIN_TONES = [
  ...['#f6ede4', '#f3e7db', '#f7ead0', '#eadaba', '#d7bd96'],
  ...['#a07e56', '#825c43', '#604134', '#3a312a', '#292420'],
  ...['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524'],
  ...['#5c3317', '#3b2219', '#ffe0bd', '#ffcd94', '#eac086'],
  ...['#d08b5b', '#c58c85', '#ae5d29', '#e8b796', '#b97a57', '#9c5a3c'],
  ...['#7a3e23', '#4a2511', '#a0522d', '#cd8c5c', '#e3a57a', '#8b4a2b'],
  ...['#6b3a24', '#d29b7a', '#f0b99a', '#c47a4f'],
  ...['#f2c4b6', '#e8a598', '#eebaa6', '#dba08c', '#f4d1c4'],
];
const MONK = { 4: '#eadaba', 8: '#604134' };

test('every skin tone, light to deep and warm-lit, is dropped; saturated oranges and reds stay', () => {
  for (const skin of SKIN_TONES)
    assert.deepEqual(
      pickPhotoAccent([skin]),
      { failed: true, fallback: 'ink' },
      skin,
    );
  for (const colour of [
    '#ff6a00',
    '#cc5500',
    '#b22222',
    '#e03c31',
    '#ffa500',
    '#daa520',
  ]) {
    const p = pickPhotoAccent([colour]);
    assert.ok(!('failed' in p), `${colour} is still a candidate`);
    assert.ok(
      hueDistance(hexToOklch(p.light.fill).h, hexToOklch(colour).h) < 4,
      colour,
    );
  }
});

test('the fallback is the same for a light face and a deep face on grey', () => {
  const on = (face) => pickPhotoAccent(['#808080', face, '#5a5a5a']);
  assert.deepEqual(on(MONK[4]), on(MONK[8]));
  assert.deepEqual(on(MONK[4]), { failed: true, fallback: 'ink' });
  // Skin first (a close-up) gives the same.
  assert.deepEqual(pickPhotoAccent([MONK[8], '#808080']), on(MONK[4]));
});

test('nothing sampled is not a contrast failure', () => {
  for (const nothing of [[], ['red', '#12345']])
    assert.deepEqual(pickPhotoAccent(nothing), {
      failed: true,
      fallback: 'ink',
      nothingSampled: true,
    });
  assert.equal(
    photoAccentNotice(pickPhotoAccent([])),
    "We couldn't find a clear colour in your photo, so your page uses Ink.",
  );
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
  // A fallback is for its photo too: a newer photo never inherits it.
  const failed = { failed: true, fallback: 'rose', avatarVersion: 9 };
  assert.equal(photoAccentSchema.safeParse(failed).success, true);
  assert.deepEqual(photoAccentOf(failed, { avatarVersion: 9 }), {
    failed: true,
    fallback: 'rose',
  });
  assert.equal(photoAccentOf(failed, { avatarVersion: 10 }), null);
  assert.equal(photoAccentOf(failed, null), null);
  const empty = { ...failed, fallback: 'ink', nothingSampled: true };
  assert.deepEqual(photoAccentOf(empty, { avatarVersion: 9 }), {
    failed: true,
    fallback: 'ink',
    nothingSampled: true,
  });
  // Anything else is nothing: no stored text reaches CSS.
  for (const bad of [
    null,
    'x',
    { ...stored, light: { ...stored.light, fill: 'red;}' } },
    { ...stored, source: 'cover' },
    { failed: true, fallback: 'rose' }, // no photo version
    { failed: true, fallback: 'photo', avatarVersion: 3 },
    { failed: true, fallback: 'teal', avatarVersion: 3 },
    { failed: true, fallback: 'ink', avatarVersion: 3, nothingSampled: 1 },
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
