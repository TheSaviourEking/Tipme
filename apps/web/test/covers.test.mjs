import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { COVER_COLOURS, COVER_DARK, COVER_DESIGNS } from '@tipme/contracts';
import {
  HEART_DESIGNS,
  HEART_LAYOUTS,
  coverView,
  heartShapes,
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

test('every heart design renders for every colour it allows', () => {
  for (const design of COVER_DESIGNS.filter((d) =>
    HEART_DESIGNS.includes(d.id),
  )) {
    const colours = design.colours
      ? COVER_COLOURS
      : [{ ...COVER_DARK, id: undefined }];
    for (const colour of colours) {
      const view = coverView(
        {
          kind: 'design',
          design: design.id,
          ...(colour.id ? { colour: colour.id } : {}),
        },
        API,
      );
      assert.equal(view.kind, 'hearts', `${design.id}/${colour.id}`);
      assert.equal(view.base, colour.base);
      assert.ok(view.shapes.length > 0);
      assert.deepEqual(
        view.shapes,
        heartShapes(design.id, colour.tone, colour.line ?? colour.tone),
      );
      for (const shape of view.shapes) {
        assert.match(shape.d, /^M/);
        assert.ok(
          shape.fill === colour.tone ||
            shape.stroke === (colour.line ?? colour.tone),
        );
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

/** Centre of a heart drawn by `translate(x y) scale(s) translate(-727 -50)`: 727, 50 is the middle of the path. */
const centreOf = (transform) => {
  const [, x, y] = transform
    .match(/^translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.]+)\)/)
    .map(Number);
  return { x, y };
};

test('each heart design has its focal point in the central 60% of the width, clear of the photo and the tipping panel', () => {
  const [left, right] = [1120 * 0.2, 1120 * 0.8];
  for (const id of HEART_DESIGNS) {
    const { focus, tile } = HEART_LAYOUTS[id];
    assert.ok(focus.x >= left && focus.x <= right, `${id} focus x ${focus.x}`);
    assert.ok(focus.y >= 60 && focus.y <= 220, `${id} focus y ${focus.y}`);
    if (tile) continue; // a tiled pattern has no single focal shape
    // The declared focus is real: some shape of the design is centred on it (the rising
    // hearts climb, so one of them), and every shape's heart lies inside the safe width.
    const centres = heartShapes(id, '#000').map((s) => centreOf(s.transform));
    assert.ok(
      centres.some((c) => Math.hypot(c.x - focus.x, c.y - focus.y) <= 10),
      `${id} has a heart at its focus`,
    );
    for (const c of centres)
      assert.ok(c.x >= left && c.x <= right, `${id} heart at ${c.x}`);
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
