import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { COVER_COLOURS, COVER_DARK, COVER_DESIGNS } from '@tipme/contracts';
import {
  HEART_DESIGNS,
  HEART_LAYOUTS,
  coverView,
} from '../src/lib/cover-view.ts';

// Sharp lives with the API, which already re-encodes uploads; the web app only needs it to look.
const sharp = createRequire(new URL('../../api/package.json', import.meta.url))(
  'sharp',
);
const dir = new URL('../public/covers/', import.meta.url);
const API = 'https://api.example.test';

const patternIds = COVER_DESIGNS.map((d) => d.id).filter(
  (id) => !HEART_DESIGNS.includes(id),
);

test('every pattern design in the catalogue has a file, and no file lacks a design', () => {
  assert.equal(patternIds.length, 18);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.webp'))
    .map((f) => f.slice(0, -'.webp'.length))
    .sort();
  assert.deepEqual(files, [...patternIds].sort());
  // The six heart designs are drawn inline, never fetched.
  assert.deepEqual(
    HEART_DESIGNS.filter((id) => !COVER_DESIGNS.some((d) => d.id === id)),
    [],
  );
});

test('every cover image is at most 120 KB and 2240x600', async () => {
  for (const id of patternIds) {
    const file = new URL(`${id}.webp`, dir);
    assert.ok(
      statSync(file).size <= 120 * 1024,
      `${id} is ${statSync(file).size} bytes`,
    );
    const meta = await sharp(readFileSync(file)).metadata();
    assert.equal(meta.format, 'webp', id);
    assert.deepEqual([meta.width, meta.height], [2240, 600], id);
  }
});

const SHAPES = {
  scattered: 2,
  large: 1,
  dark: 1,
  outline: 2,
  ripple: 5,
  rising: 4,
};
const OUTLINED = ['outline', 'ripple'];
// One heart the eye lands on, rather than a scatter or a climb across the width.
const SINGLE_FOCUS = ['large', 'dark', 'ripple'];

test('every heart design renders for every colour it allows', () => {
  assert.deepEqual([...HEART_DESIGNS].sort(), Object.keys(SHAPES).sort());
  for (const design of COVER_DESIGNS.filter((d) =>
    HEART_DESIGNS.includes(d.id),
  )) {
    const colours = design.colours
      ? COVER_COLOURS
      : [{ ...COVER_DARK, id: undefined }];
    for (const colour of colours) {
      const label = `${design.id}/${colour.id}`;
      const view = coverView(
        {
          kind: 'design',
          design: design.id,
          ...(colour.id ? { colour: colour.id } : {}),
        },
        API,
      );
      assert.equal(view.kind, 'hearts', label);
      assert.equal(view.base, colour.base, label);
      assert.equal(view.shapes.length, SHAPES[design.id], label);
      for (const shape of view.shapes) {
        assert.match(shape.d, /^M/, label);
        if (OUTLINED.includes(design.id)) {
          assert.equal(shape.stroke, colour.line, label);
          assert.equal(shape.fill, undefined, label);
          assert.ok(shape.strokeWidth > 0, label);
        } else {
          assert.equal(shape.fill, colour.tone, label);
          assert.equal(shape.stroke, undefined, label);
        }
      }
    }
  }
});

test('a pattern design is a file; a photo is vetted like an avatar; anything else falls back', () => {
  assert.deepEqual(coverView({ kind: 'design', design: 'danfo' }, API), {
    kind: 'image',
    src: '/covers/danfo.webp',
    unoptimized: false,
  });
  assert.deepEqual(
    coverView({ kind: 'photo', path: '/v1/covers/abc-1/3.webp' }, API),
    { kind: 'image', src: `${API}/v1/covers/abc-1/3.webp`, unoptimized: true },
  );
  const automatic = coverView(
    { kind: 'design', design: 'scattered', colour: 'neutral' },
    API,
  );
  assert.equal(automatic.kind, 'hearts');
  for (const bad of [
    { kind: 'photo', path: 'https://evil.example/x.webp' },
    { kind: 'photo', path: '/v1/covers/../x.webp' },
    { kind: 'photo', path: '/v1/avatars/abc/3.webp' },
    { kind: 'design', design: 'no-such-design' },
    { kind: 'design', design: '../../etc' },
  ]) {
    assert.deepEqual(coverView(bad, API), automatic, JSON.stringify(bad));
  }
  // A colour the catalogue no longer holds falls back to neutral.
  assert.equal(
    coverView({ kind: 'design', design: 'large', colour: 'gone' }, API).base,
    COVER_COLOURS.find((c) => c.id === 'neutral').base,
  );
});

/** Draws a design's shapes in black on white at the artboard's own size, and reads the pixels. */
async function rasterise(id, shapes) {
  const { height, tile } = HEART_LAYOUTS[id];
  const paths = shapes
    .map(
      (s) =>
        `<path d="${s.d}" transform="${s.transform}" fill="${s.fill ? '#000' : 'none'}"` +
        (s.stroke ? ` stroke="#000" stroke-width="${s.strokeWidth}"` : '') +
        '/>',
    )
    .join('');
  const body = tile
    ? `<defs><pattern id="p" width="${tile.width}" height="${tile.height}" patternUnits="userSpaceOnUse">${paths}</pattern></defs><rect y="-20" width="1120" height="340" fill="url(#p)"/>`
    : paths;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="300" viewBox="0 ${(height - 300) / 2} 1120 300"><rect y="-50" width="1120" height="400" fill="#fff"/>${body}</svg>`;
  const { data } = await sharp(Buffer.from(svg))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const dark = (x, y) => data[y * 1120 + x] < 170;
  let n = 0,
    sx = 0,
    sy = 0,
    x0 = 1120,
    x1 = -1,
    y0 = 300,
    y1 = -1;
  for (let y = 0; y < 300; y += 1)
    for (let x = 0; x < 1120; x += 1)
      if (dark(x, y)) {
        n += 1;
        sx += x;
        sy += y;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return { dark, n, cx: sx / n, cy: sy / n, x0, x1, y0, y1 };
}

// A phone shows the 1120 x 300 artboard in a 390 x 168 frame, sliced: the middle ~62%.
const SEEN = 390 / (168 / 300);
const [seenFrom, seenTo] = [(1120 - SEEN) / 2, (1120 + SEEN) / 2];

test('each heart design reads on a phone: drawn geometry sits in the middle, clear of the photo and the tipping panel', async () => {
  assert.ok(seenFrom > 200 && seenTo < 920);
  for (const id of HEART_DESIGNS) {
    const view = coverView(
      { kind: 'design', design: id, colour: 'neutral' },
      API,
    );
    // The ripple's outer rings run off the edges on purpose; its focal shape is the inner heart.
    const focal = id === 'ripple' ? view.shapes.slice(0, 1) : view.shapes;
    const art = await rasterise(id, focal);
    assert.ok(art.n > 0, id);
    assert.ok(art.cx >= 224 && art.cx <= 896, `${id} centre x ${art.cx}`);
    assert.ok(art.cy >= 60 && art.cy <= 240, `${id} centre y ${art.cy}`);
    if (SINGLE_FOCUS.includes(id))
      assert.ok(Math.abs(art.cx - 560) < 60, `${id} off centre at ${art.cx}`);
    if (HEART_LAYOUTS[id].tile) {
      // Tiled hearts: plenty of them show in the phone's window, but never a solid mass.
      let inside = 0;
      for (let y = 0; y < 300; y += 1)
        for (let x = Math.ceil(seenFrom); x < seenTo; x += 1)
          if (art.dark(x, y)) inside += 1;
      const share = inside / (300 * (seenTo - seenFrom));
      assert.ok(share > 0.01 && share < 0.4, `${id} covers ${share}`);
      continue;
    }
    // Clear of the profile photo (lower left) and the tipping panel (lower right).
    for (let y = 190; y < 300; y += 1)
      for (let x = 0; x < 260; x += 1)
        assert.ok(!art.dark(x, y), `${id} under the photo at ${x},${y}`);
    for (let y = 120; y < 300; y += 1)
      for (let x = 860; x < 1120; x += 1)
        assert.ok(!art.dark(x, y), `${id} under the panel at ${x},${y}`);
    if (id === 'large' || id === 'dark') {
      // One big heart: whole, and filling a fair share of the width.
      assert.ok(
        art.x0 >= seenFrom && art.x1 <= seenTo,
        `${id} heart ${art.x0}..${art.x1} fits the phone`,
      );
      assert.ok(
        art.x1 - art.x0 >= 0.2 * 1120,
        `${id} heart is ${art.x1 - art.x0} wide`,
      );
      assert.ok(art.y0 >= 0 && art.y1 <= 300, `${id} heart is whole`);
    }
  }
});

test('outline strokes are readable on every base: contrast of at least 1.4, and quiet, under 4', () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const c of COVER_COLOURS) {
    const [a, b] = [lum(c.base), lum(c.line)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    assert.ok(
      ratio >= 1.4 && ratio < 4,
      `${c.id} line contrast ${ratio.toFixed(2)}`,
    );
  }
});
