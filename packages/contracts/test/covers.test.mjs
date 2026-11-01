import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COVER_COLOURS,
  COVER_DARK,
  COVER_DESIGNS,
  automaticCover,
  coverDesignChoiceSchema,
  resolveCover,
} from '../dist/index.js';

const HEARTS = ['scattered', 'large', 'dark', 'outline', 'ripple', 'rising'];
const PATTERNS = [
  'indigo',
  'woven',
  'danfo',
  'harmattan',
  'lagoon',
  'citylights',
  'vinyl',
  'waveform',
  'sunburst',
  'engraved',
  'contour',
  'flow',
  'geometry',
  'overprint',
  'paper',
  'terrazzo',
  'opcheck',
  'confetti',
];

test('the catalogue holds the six heart and eighteen pattern designs, each named', () => {
  assert.deepEqual(
    COVER_DESIGNS.map((d) => d.id),
    [...HEARTS, ...PATTERNS],
  );
  for (const design of COVER_DESIGNS) assert.ok(design.name.length > 0);
});

test('only heart designs other than dark take a colour', () => {
  assert.deepEqual(
    COVER_DESIGNS.filter((d) => d.colours).map((d) => d.id),
    HEARTS.filter((id) => id !== 'dark'),
  );
});

test('colours carry the mockup’s base and tone, neutral first', () => {
  assert.deepEqual(
    COVER_COLOURS.map((c) => [c.id, c.name, c.base, c.tone]),
    [
      ['neutral', 'Neutral', '#e6e4dc', '#d6d3c8'],
      ['violet', 'Violet', '#7a32f9', '#6723e8'],
      ['lilac', 'Lilac', '#ece2ff', '#ddcbff'],
      ['forest', 'Forest', '#1f4d3a', '#2a6049'],
      ['ocean', 'Ocean', '#1d4e89', '#2a609f'],
      ['sun', 'Sun', '#f4c25b', '#ebb03b'],
      ['rose', 'Rose', '#b83d62', '#c9547a'],
    ],
  );
  assert.deepEqual(COVER_DARK, { base: '#24221f', tone: '#33302b' });
});

// Pinned on purpose. These come from FNV-1a over the lower-case handle, worked out separately
// from the code. If this test fails, every page without a chosen cover has just changed design:
// don't update the values unless the owner wants that.
const PINNED = {
  ada: 'large',
  tobi: 'dark',
  chioma: 'large',
  emeka: 'scattered',
  photo_ada: 'large',
  bisi_hair: 'scattered',
  dj_tunde: 'large',
  a1b: 'scattered',
};

test('automatic cover: pinned handles keep their design', () => {
  for (const [handle, design] of Object.entries(PINNED))
    assert.equal(automaticCover(handle), design, handle);
});

test('automatic cover is stable, ignores case, and is one of the three', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const handle = `page_${i}`;
    const design = automaticCover(handle);
    assert.equal(automaticCover(handle), design);
    assert.equal(automaticCover(handle.toUpperCase()), design);
    assert.ok(['scattered', 'large', 'dark'].includes(design), design);
    seen.add(design);
  }
  assert.equal(seen.size, 3, 'all three are in use');
});

const page = (over = {}) => ({
  handle: 'emeka',
  coverPath: null,
  coverDesign: null,
  coverColour: null,
  ...over,
});

test('photo beats design beats automatic', () => {
  const path = '/v1/covers/abc/3.webp';
  assert.deepEqual(
    resolveCover(
      page({ coverPath: path, coverDesign: 'danfo', coverColour: null }),
    ),
    { kind: 'photo', path },
  );
  assert.deepEqual(resolveCover(page({ coverDesign: 'danfo' })), {
    kind: 'design',
    design: 'danfo',
  });
  assert.deepEqual(resolveCover(page()), {
    kind: 'design',
    design: automaticCover('emeka'),
    colour: 'neutral',
  });
});

test('a chosen colour is kept; a design that takes one defaults to neutral', () => {
  assert.deepEqual(
    resolveCover(page({ coverDesign: 'ripple', coverColour: 'rose' })),
    { kind: 'design', design: 'ripple', colour: 'rose' },
  );
  assert.deepEqual(resolveCover(page({ coverDesign: 'ripple' })), {
    kind: 'design',
    design: 'ripple',
    colour: 'neutral',
  });
});

test('an automatic dark cover has no colour, and automatic never picks violet or lilac', () => {
  assert.deepEqual(resolveCover(page({ handle: 'tobi' })), {
    kind: 'design',
    design: 'dark',
  });
});

test('an option removed from the catalogue falls back, so removing one is deleting one entry', () => {
  assert.deepEqual(resolveCover(page({ coverDesign: 'retired' })), {
    kind: 'design',
    design: automaticCover('emeka'),
    colour: 'neutral',
  });
  assert.deepEqual(
    resolveCover(page({ coverDesign: 'large', coverColour: 'retired' })),
    { kind: 'design', design: 'large', colour: 'neutral' },
  );
  assert.deepEqual(
    resolveCover(page({ coverDesign: 'danfo', coverColour: 'rose' })),
    { kind: 'design', design: 'danfo' },
  );
});

test('a design choice accepts the catalogue and nothing else', () => {
  const ok = (body) => coverDesignChoiceSchema.safeParse(body).success;
  assert.equal(ok({ design: 'danfo' }), true);
  assert.equal(ok({ design: 'large', colour: 'rose' }), true);
  assert.equal(ok({ design: 'large', colour: null }), true);
  assert.equal(ok({ design: 'danfo', colour: null }), true);
  assert.equal(ok({ design: null }), true);
  assert.equal(ok({ design: null, colour: null }), true);

  assert.equal(ok({ design: 'retired' }), false);
  assert.equal(ok({ design: '__proto__' }), false);
  assert.equal(ok({ design: 'constructor' }), false);
  assert.equal(ok({ design: 'large', colour: 'puce' }), false);
  assert.equal(ok({ design: 'danfo', colour: 'rose' }), false);
  assert.equal(ok({ design: 'dark', colour: 'neutral' }), false);
  assert.equal(ok({ design: null, colour: 'rose' }), false);
  assert.equal(ok({}), false);
  assert.equal(ok({ design: 'large', extra: 1 }), false);
});
