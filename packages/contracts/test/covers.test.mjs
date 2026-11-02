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

test('colours carry the mockup’s base and the deeper tones chosen on 2 Nov 2026, neutral first', () => {
  assert.deepEqual(
    COVER_COLOURS.map((c) => [c.id, c.name, c.base, c.tone]),
    [
      ['neutral', 'Neutral', '#e6e4dc', '#bdb8a5'],
      ['violet', 'Violet', '#7a32f9', '#5415c9'],
      ['lilac', 'Lilac', '#ece2ff', '#c9b0fb'],
      ['forest', 'Forest', '#1f4d3a', '#357a5c'],
      ['ocean', 'Ocean', '#1d4e89', '#3a79c2'],
      ['sun', 'Sun', '#f4c25b', '#d99a1a'],
      ['rose', 'Rose', '#b83d62', '#d9648a'],
    ],
  );
  assert.deepEqual(COVER_DARK, {
    base: '#24221f',
    tone: '#4a463f',
    line: '#7a746a',
  });
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

/** Runs `work` with `ids` taken out of a catalogue, as deleting their entries would. */
function without(catalogue, ids, work) {
  const original = [...catalogue];
  const kept = original.filter((entry) => !ids.includes(entry.id));
  catalogue.splice(0, catalogue.length, ...kept);
  try {
    work();
  } finally {
    catalogue.splice(0, catalogue.length, ...original);
  }
}

const HANDLES = Array.from({ length: 60 }, (_, i) => `page_${i}`);

test('removing any design from the catalogue never breaks a page', () => {
  const removals = [
    ...COVER_DESIGNS.map((design) => [design.id]),
    ['scattered', 'large'],
    ['scattered', 'large', 'dark'],
  ];
  for (const ids of removals)
    without(COVER_DESIGNS, ids, () => {
      for (const handle of HANDLES) {
        const auto = automaticCover(handle);
        assert.ok(
          COVER_DESIGNS.some((d) => d.id === auto),
          `${ids}: ${auto}`,
        );
        for (const coverDesign of [null, ids[0]]) {
          const cover = resolveCover(page({ handle, coverDesign }));
          assert.ok(!ids.includes(cover.design), `${ids}: ${cover.design}`);
        }
      }
    });
});

test('removing an automatic design moves only the pages that had it', () => {
  const before = new Map(HANDLES.map((h) => [h, automaticCover(h)]));
  without(COVER_DESIGNS, ['dark'], () => {
    for (const handle of HANDLES)
      if (before.get(handle) !== 'dark')
        assert.equal(automaticCover(handle), before.get(handle), handle);
  });
});

test('removing any colour from the catalogue never offers a missing one', () => {
  for (const { id } of [...COVER_COLOURS])
    without(COVER_COLOURS, [id], () => {
      const cover = resolveCover(
        page({ coverDesign: 'ripple', coverColour: id }),
      );
      assert.ok(
        COVER_COLOURS.some((c) => c.id === cover.colour),
        id,
      );
    });
});
