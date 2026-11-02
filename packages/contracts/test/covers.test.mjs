import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COVER_COLOURS,
  COVER_DARK,
  COVER_DESIGNS,
  AUTOMATIC_COLOURS,
  AUTOMATIC_DESIGNS,
  automaticColour,
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

// Pinned on purpose, as (design, colour). These come from FNV-1a over the lower-case handle (the
// design from the hash, the colour from a finalised copy of it), worked out separately from the
// code in Python. If this test fails, every page without a chosen cover has just
// changed look: don't update the values unless the owner wants that.
const PINNED = {
  ada: ['large', 'ocean'],
  tobi: ['rising', 'violet'],
  chioma: ['large', 'violet'],
  emeka: ['scattered', 'violet'],
  photo_ada: ['large', 'forest'],
  bisi_hair: ['scattered', 'forest'],
  dj_tunde: ['large', 'forest'],
  a1b: ['scattered', 'rose'],
};

test('automatic cover: pinned handles keep their design and colour', () => {
  for (const [handle, [design, colour]] of Object.entries(PINNED)) {
    assert.equal(automaticCover(handle), design, handle);
    assert.equal(automaticColour(handle), colour, handle);
  }
});

test('automatic designs are the filled hearts A, B and C; colours are violet, forest, ocean and rose', () => {
  assert.deepEqual(AUTOMATIC_DESIGNS, ['scattered', 'large', 'rising']);
  assert.deepEqual(AUTOMATIC_COLOURS, ['violet', 'forest', 'ocean', 'rose']);
});

test('automatic cover is stable, ignores case, and is always one of the twelve combinations', () => {
  for (let i = 0; i < 300; i += 1) {
    const handle = `page_${i}`;
    assert.equal(automaticCover(handle), automaticCover(handle));
    assert.equal(automaticCover(handle.toUpperCase()), automaticCover(handle));
    assert.equal(
      automaticColour(handle.toUpperCase()),
      automaticColour(handle),
    );
    assert.ok(AUTOMATIC_DESIGNS.includes(automaticCover(handle)));
    assert.ok(AUTOMATIC_COLOURS.includes(automaticColour(handle)));
  }
});

// The owner's call (2 Nov 2026): rich colours, spread across the four. The colour must not follow
// the design, or some pairings would never occur. A sample of handles shaped like real ones
// (names, names with digits, underscores) fills a 3 x 4 table; each cell should hold about a
// twelfth, and each colour about a quarter within every design.
const SAMPLE = (() => {
  const names = ['ada', 'tobi', 'chioma', 'emeka', 'bisi', 'dj', 'ife', 'zara'];
  const out = [];
  for (let i = 0; i < 2400; i += 1)
    out.push(
      i % 3 === 0
        ? `${names[i % names.length]}_${i}`
        : i % 3 === 1
          ? `${names[(i * 7) % names.length]}${i}`
          : `page_${i}`,
    );
  return out;
})();

test('automatic designs and colours spread evenly and independently across handles', (t) => {
  const cell = new Map();
  for (const handle of SAMPLE) {
    const key = `${automaticCover(handle)}/${automaticColour(handle)}`;
    cell.set(key, (cell.get(key) ?? 0) + 1);
  }
  const rows = AUTOMATIC_DESIGNS.map((d) =>
    [
      d.padEnd(10),
      ...AUTOMATIC_COLOURS.map((c) =>
        String(cell.get(`${d}/${c}`) ?? 0).padStart(6),
      ),
    ].join(' '),
  );
  t.diagnostic(
    `distribution of ${SAMPLE.length} handles\n${''.padEnd(10)} ${AUTOMATIC_COLOURS.map((c) => c.padStart(6)).join(' ')}\n${rows.join('\n')}`,
  );
  const expected = SAMPLE.length / 12;
  for (const d of AUTOMATIC_DESIGNS)
    for (const c of AUTOMATIC_COLOURS) {
      const n = cell.get(`${d}/${c}`) ?? 0;
      // About 4.4 standard deviations either side of an even spread.
      assert.ok(
        n > expected * 0.7 && n < expected * 1.3,
        `${d}/${c} has ${n} of ${SAMPLE.length}`,
      );
    }
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
    colour: automaticColour('emeka'),
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

test('a page with no chosen cover gets its handle’s automatic design and colour; a chosen design is left as it was', () => {
  for (const handle of SAMPLE.slice(0, 40)) {
    assert.deepEqual(resolveCover(page({ handle })), {
      kind: 'design',
      design: automaticCover(handle),
      colour: automaticColour(handle),
    });
    // Chosen with no colour stays neutral: those pages must not change with the automatic rule.
    assert.deepEqual(resolveCover(page({ handle, coverDesign: 'large' })), {
      kind: 'design',
      design: 'large',
      colour: 'neutral',
    });
    assert.deepEqual(resolveCover(page({ handle, coverDesign: 'dark' })), {
      kind: 'design',
      design: 'dark',
    });
  }
});

test('the automatic cover follows the handle, so a renamed page may change look', () => {
  const looks = new Set(
    ['ada', 'ada2', 'ada_x', 'ada-b', 'adaa', 'adab', 'adac', 'adad'].map(
      (handle) => JSON.stringify(resolveCover(page({ handle }))),
    ),
  );
  assert.ok(looks.size > 1);
});

test('an option removed from the catalogue falls back, so removing one is deleting one entry', () => {
  assert.deepEqual(resolveCover(page({ coverDesign: 'retired' })), {
    kind: 'design',
    design: automaticCover('emeka'),
    colour: automaticColour('emeka'),
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
    ['scattered', 'large', 'rising'],
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
  without(COVER_DESIGNS, ['rising'], () => {
    for (const handle of HANDLES)
      if (before.get(handle) !== 'rising')
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

test('removing an automatic colour moves only the pages that had it, and never offers a missing one', () => {
  const before = new Map(HANDLES.map((h) => [h, automaticColour(h)]));
  for (const gone of AUTOMATIC_COLOURS)
    without(COVER_COLOURS, [gone], () => {
      for (const handle of HANDLES) {
        const colour = automaticColour(handle);
        assert.ok(
          COVER_COLOURS.some((c) => c.id === colour),
          `${gone}: ${colour}`,
        );
        if (before.get(handle) !== gone)
          assert.equal(colour, before.get(handle), handle);
      }
    });
});
