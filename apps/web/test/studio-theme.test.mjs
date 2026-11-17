import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_FONTS,
  STUDIO_SPACING,
  contrastRatio,
  deriveStudioPalette,
  studioTypeScale,
} from '@tipme/contracts';
import {
  STUDIO_COLOUR_TOKENS,
  studioFontFaces,
  studioImageSources,
  studioStyle,
} from '../src/components/studio/studio-theme.ts';

const doc = (extra = {}) => ({
  v: 1,
  brand: ['#1d4e89'],
  mode: 'light',
  fonts: { heading: 'fraunces', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows: [],
  ...extra,
});
const style = (d) => studioStyle(d, deriveStudioPalette(d.brand));

test('studioStyle sets only --studio-* properties, all derived from the palette and scale', () => {
  for (const d of [
    doc(),
    doc({
      brand: ['#f5c400', '#1d4e89'],
      mode: 'auto',
      scale: 'roomy',
      corners: 'round',
    }),
  ]) {
    const s = style(d);
    const palette = deriveStudioPalette(d.brand);
    const colours = new Set(
      ['light', 'dark'].flatMap((m) => [
        ...Object.values(palette[m]).filter((v) => typeof v === 'string'),
        ...Object.values(palette[m].second ?? {}),
      ]),
    );
    const sizes = new Set(
      Object.values(studioTypeScale(d.scale)).map((t) => t.css),
    );
    for (const [key, value] of Object.entries(s)) {
      assert.match(key, /^--studio-[a-z0-9-]+$/, key);
      if (/^#/.test(value))
        assert.ok(
          colours.has(value),
          `${key}: ${value} is not a derived colour`,
        );
      if (key.startsWith('--studio-size-')) assert.ok(sizes.has(value), key);
      // Nothing a person typed: only hex, clamp(), lengths, numbers and registry font stacks.
      assert.match(
        value,
        /^(#[0-9a-f]{6}|clamp\([\d.a-z +,()-]+\)|[\d.]+(px)?|'Studio [A-Za-z0-9 ]+', var\(--font-glyph-fallback, 'Studio Glyphs'\), 'Studio [A-Za-z0-9 ]+ Fallback', (serif|sans-serif))$/,
        `${key}: ${value}`,
      );
    }
    // The brand hex itself only appears where the engine kept it as a derived token.
    assert.ok(!Object.values(s).includes('#ff0000'));
  }
});

test('light and dark pages emit one token set; auto emits both', () => {
  const keys = (d) => Object.keys(style(d));
  for (const t of STUDIO_COLOUR_TOKENS) {
    assert.ok(keys(doc()).includes(`--studio-l-${t}`), t);
    assert.ok(!keys(doc()).some((k) => k.startsWith('--studio-d-')));
    assert.ok(keys(doc({ mode: 'dark' })).includes(`--studio-d-${t}`), t);
    assert.ok(keys(doc({ mode: 'auto' })).includes(`--studio-l-${t}`), t);
    assert.ok(keys(doc({ mode: 'auto' })).includes(`--studio-d-${t}`), t);
  }
});

test('a button too light to see on its page gets a border that is', () => {
  for (const [brand, mode] of [
    [['#ffffff'], 'light'],
    [['#f5c400'], 'light'],
    [['#000000'], 'dark'],
    [['#1d4e89'], 'light'],
  ]) {
    const d = doc({ brand, mode });
    const s = style(d);
    const m = mode === 'light' ? 'l' : 'd';
    const tokens = deriveStudioPalette(brand)[mode];
    const visible = (c) =>
      Math.min(contrastRatio(c, tokens.page), contrastRatio(c, tokens.card)) >=
      3;
    assert.ok(
      visible(s[`--studio-${m}-button-edge`]) || visible(tokens.button),
      `${brand} ${mode}`,
    );
  }
});

test('spacing and corners come from fixed steps', () => {
  const s = style(doc({ corners: 'square' }));
  for (const step of ['s', 'm', 'l'])
    assert.equal(
      s[`--studio-space-${step}`].startsWith(
        `clamp(${STUDIO_SPACING[step].min}px, `,
      ),
      true,
      step,
    );
  assert.equal(s['--studio-radius'], '0px');
  assert.equal(
    style(doc({ corners: 'round' }))['--studio-radius-button'],
    '999px',
  );
});

test("studio-fonts emits @font-face only for the page's families, with metric fallbacks", () => {
  const css = studioFontFaces({ heading: 'fraunces', body: 'inter' });
  const used = STUDIO_FONTS.filter((f) => ['fraunces', 'inter'].includes(f.id));
  for (const f of STUDIO_FONTS) {
    const present = css.includes(f.files[0].path);
    assert.equal(present, used.includes(f), f.id);
  }
  assert.equal(
    (css.match(/@font-face/g) ?? []).length,
    4,
    'two families and two fallbacks',
  );
  assert.match(
    css,
    /font-family: 'Studio Fraunces Fallback';\s*src: local\('Georgia'\);\s*size-adjust: [\d.]+%;\s*ascent-override: [\d.]+%;\s*descent-override: [\d.]+%;/,
  );
  assert.match(css, /font-display: swap;/);
  const one = studioFontFaces({ heading: 'nunito', body: 'nunito' });
  assert.equal(
    (one.match(/@font-face/g) ?? []).length,
    2,
    'one family loads once',
  );
  assert.doesNotMatch(css, /[<>{}]\s*[<>]/);
});

test('photo sources: renditions never larger than the photo, sized by the layout', () => {
  const image = { path: '/v1/studio-images/p/i', width: 1000, height: 1000 };
  const { src, srcSet, width, height } = studioImageSources(image, 'square');
  assert.equal(src, '/v1/studio-images/p/i/square-480');
  assert.equal(
    srcSet,
    '/v1/studio-images/p/i/square-480 480w, /v1/studio-images/p/i/square-960 960w',
  );
  assert.deepEqual([width, height], [960, 960]);
  const wide = studioImageSources(
    { ...image, width: 4000, height: 3000 },
    'wide',
  );
  assert.match(wide.srcSet, /wide-1440 1440w$/);
  assert.deepEqual([wide.width, wide.height], [1440, 810]);
});
