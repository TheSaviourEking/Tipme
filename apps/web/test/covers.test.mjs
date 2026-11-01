import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { COVER_COLOURS, COVER_DARK, COVER_DESIGNS } from '@tipme/contracts';
import {
  HEART_DESIGNS,
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
      ? COVER_COLOURS.map((c) => ({ base: c.base, tone: c.tone, id: c.id }))
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
      assert.deepEqual(view.shapes, heartShapes(design.id, colour.tone));
      for (const shape of view.shapes) {
        assert.match(shape.d, /^M/);
        assert.ok(shape.fill === colour.tone || shape.stroke === colour.tone);
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
