import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  STUDIO_LIMITS,
  STUDIO_PRO_BLOCKS,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  defaultStudioDocument,
  isClassicDefault,
  resolveStudio,
  studioDocumentSchema,
  studioImageIdsOf,
} from '../dist/index.js';
import { TODAY, studioDocumentArb } from './support/studio-arbitrary.mjs';
import { studioDocumentV1Arb } from './support/studio-arbitrary.mjs';

const VALID = {
  v: 2,
  style: 'clear',
  accent: 'blue',
  mode: 'light',
  cover: 'yours',
  blocks: [
    { id: 'blk00001', kind: 'text', variant: 'heading', text: 'Hello' },
    {
      id: 'blk00002',
      kind: 'photo',
      imageId: '00000000-0000-4000-8000-000000000000',
      alt: 'A photo',
    },
  ],
};
const ok = (d) => studioDocumentSchema.safeParse(d).success;
const withBlocks = (blocks) => ({ ...VALID, blocks });
let n = 0;
const bid = () => `b${String(n++).padStart(7, '0')}`;
const IMG = '00000000-0000-4000-8000-000000000000';
const paragraph = () => ({
  id: bid(),
  kind: 'text',
  variant: 'paragraph',
  text: 'x',
});
const photo = () => ({ id: bid(), kind: 'photo', imageId: IMG, alt: 'a' });
const gallery = (count) => ({
  id: bid(),
  kind: 'gallery',
  images: Array.from({ length: count }, () => ({ imageId: IMG, alt: 'a' })),
});
const video = () => ({
  id: bid(),
  kind: 'video',
  url: 'https://youtu.be/9bZkp7q19f0',
});
const events = (count) => ({
  id: bid(),
  kind: 'events',
  items: Array.from({ length: count }, () => ({
    date: '2027-01-01',
    title: 'Show',
  })),
});
const services = (count) => ({
  id: bid(),
  kind: 'services',
  items: Array.from({ length: count }, () => ({
    name: 'Cut',
    priceMinor: '500000',
  })),
});

test('the valid v2 example parses', () => {
  assert.equal(ok(VALID), true);
});

test('a v2 document stores only ids and enums', () => {
  for (const extra of [
    { brand: ['#7a32f9'] },
    { fonts: { heading: 'manrope', body: 'inter' } },
    { scale: 'standard' },
    { corners: 'soft' },
    { rows: [] },
  ])
    assert.equal(ok({ ...VALID, ...extra }), false, Object.keys(extra)[0]);
  // Presentation choices a block could carry.
  const base = {
    photo: { kind: 'photo', imageId: IMG, alt: 'a' },
    gallery: { kind: 'gallery', images: [] },
    video: { kind: 'video', url: 'https://youtu.be/9bZkp7q19f0' },
    services: { kind: 'services', items: [] },
    events: { kind: 'events', items: [] },
    quote: { kind: 'quote', text: 'x' },
  };
  for (const [kind, b] of Object.entries(base)) {
    assert.equal(ok(withBlocks([{ id: 'aaaaaaaa', ...b }])), true, kind);
    assert.equal(
      ok(withBlocks([{ id: 'aaaaaaaa', ...b, variant: 'wide' }])),
      false,
      `${kind} variant`,
    );
  }
  for (const kind of ['about', 'links'])
    assert.equal(
      ok(withBlocks([{ id: 'aaaaaaaa', kind, variant: 'plain' }])),
      false,
      kind,
    );
  assert.equal(ok(withBlocks([{ id: 'aaaaaaaa', kind: 'about' }])), false);
  assert.equal(ok(withBlocks([{ id: 'aaaaaaaa', kind: 'links' }])), false);
  const text = (extra) =>
    withBlocks([
      { id: 'aaaaaaaa', kind: 'text', variant: 'heading', text: 'x', ...extra },
    ]);
  assert.equal(ok(text({})), true);
  assert.equal(ok(text({ level: 2 })), false, 'text level');
  assert.equal(ok(text({ variant: 'lead' })), false, 'text lead');
  assert.equal(
    ok(
      withBlocks([
        { id: 'aaaaaaaa', kind: 'text', variant: 'paragraph', text: 'x' },
      ]),
    ),
    true,
  );
});

test('limits: 40 blocks, 24 photos, 9 per gallery, 3 videos, 6 events, 12 services', () => {
  assert.equal(STUDIO_LIMITS.blocks, 40);
  const rep = (make, count) => Array.from({ length: count }, make);
  const cases = [
    ['blocks', (c) => rep(paragraph, c), 40],
    ['photos', (c) => rep(photo, c), 24],
    ['gallery photos', (c) => [gallery(c)], 9],
    ['page photos across galleries', (c) => rep(() => gallery(8), c / 8), 24],
    ['videos', (c) => rep(video, c), 3],
    ['events', (c) => [events(c)], 6],
    ['services', (c) => [services(c)], 12],
  ];
  for (const [name, make, limit] of cases) {
    assert.equal(ok(withBlocks(make(limit))), true, `${name} at ${limit}`);
    const over = name.startsWith('page photos')
      ? [...make(limit), photo()]
      : make(limit + 1);
    assert.equal(ok(withBlocks(over)), false, `${name} over ${limit}`);
  }
});

test('ids are unique and a cover the style offers is required by the schema', () => {
  const dup = { ...paragraph(), id: 'aaaaaaaa' };
  assert.equal(ok(withBlocks([dup, dup])), false);
  assert.equal(ok({ ...VALID, style: 'sprint', cover: 'gradient' }), false);
  assert.equal(ok({ ...VALID, style: 'sprint', cover: 'plain' }), true);
});

test('a cover type the style does not offer resolves to Your cover', () => {
  for (const style of ['sprint', 'signboard']) {
    assert.equal(STUDIO_STYLES[style].covers.includes('gradient'), false);
    const out = resolveStudio({ ...VALID, style, cover: 'gradient' }, TODAY);
    assert.equal(out.cover, 'yours', style);
    assert.equal(out.style, style);
  }
  // A cover the style does offer is kept.
  assert.equal(
    resolveStudio({ ...VALID, style: 'sprint', cover: 'plain' }, TODAY).cover,
    'plain',
  );
  assert.equal(
    resolveStudio({ ...VALID, style: 'stage', cover: 'gradient' }, TODAY).cover,
    'gradient',
  );
});

test('resolveStudio never throws, is idempotent and always yields a schema-valid v2 document', () => {
  const anything = fc.oneof(
    fc.json().map((s) => JSON.parse(s)),
    fc.anything(),
  );
  const check = (raw) => {
    const once = resolveStudio(raw, TODAY);
    assert.equal(studioDocumentSchema.safeParse(once).success, true);
    assert.deepEqual(resolveStudio(once, TODAY), once);
    assert.deepEqual(resolveStudio(structuredClone(raw), TODAY), once);
  };
  fc.assert(fc.property(studioDocumentArb({ valid: true }), check), {
    numRuns: 300,
  });
  fc.assert(fc.property(studioDocumentArb({ valid: false }), check), {
    numRuns: 300,
  });
  fc.assert(fc.property(studioDocumentV1Arb({ valid: true }), check), {
    numRuns: 300,
  });
  fc.assert(fc.property(studioDocumentV1Arb({ valid: false }), check), {
    numRuns: 200,
  });
  fc.assert(fc.property(anything, check), { numRuns: 500 });
  for (const raw of [null, undefined, 3, 'x', [], {}, { v: 2 }, { v: 1 }])
    check(raw);
});

test('a rich document with every optional field round-trips through resolveStudio unchanged', () => {
  const rich = {
    v: 2,
    style: 'stage',
    accent: 'photo',
    mode: 'auto',
    cover: 'gradient',
    blocks: [
      { id: 'rich0001', kind: 'text', variant: 'heading', text: 'Ẹ káàbọ̀' },
      {
        id: 'rich0002',
        kind: 'text',
        variant: 'paragraph',
        text: 'One.\n\nTwo.\n\nThree.\n\nFour.',
      },
      {
        id: 'rich0003',
        kind: 'photo',
        imageId: IMG,
        alt: '',
        decorative: true,
        caption: 'Caption',
      },
      {
        id: 'rich0004',
        kind: 'gallery',
        images: [
          { imageId: IMG, alt: 'One', decorative: true },
          { imageId: '11111111-1111-4111-8111-111111111111', alt: 'Two' },
        ],
      },
      {
        id: 'rich0005',
        kind: 'video',
        url: 'https://youtu.be/9bZkp7q19f0',
        caption: 'Clip',
      },
      {
        id: 'rich0006',
        kind: 'services',
        items: [
          {
            name: 'Cut',
            detail: 'Skin fade',
            priceMinor: '500000',
            from: true,
          },
          { name: 'Beard', priceMinor: '200000' },
        ],
      },
      {
        id: 'rich0007',
        kind: 'events',
        items: [
          {
            date: TODAY,
            time: '19:30',
            title: 'Show',
            place: 'Lekki',
            note: 'Doors 7',
          },
          { date: '2027-01-01', title: 'Later' },
        ],
      },
      { id: 'rich0008', kind: 'quote', text: 'Thank you' },
    ],
  };
  assert.equal(studioDocumentSchema.safeParse(rich).success, true);
  assert.deepEqual(resolveStudio(rich, TODAY), rich);
});

test('every generated valid v2 document is accepted, and broken ones never are', () => {
  fc.assert(
    fc.property(studioDocumentArb({ valid: true }), (d) => {
      assert.equal(studioDocumentSchema.safeParse(d).success, true);
      assert.deepEqual(resolveStudio(JSON.parse(JSON.stringify(d)), TODAY), d);
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(studioDocumentArb({ valid: false }), (d) =>
      assert.equal(studioDocumentSchema.safeParse(d).success, false),
    ),
    { numRuns: 300 },
  );
});

test('resolveStudio replaces what it cannot use and trims from the end', () => {
  const out = resolveStudio(
    {
      v: 2,
      style: 'neon',
      accent: 'magenta',
      mode: 'neon',
      cover: 'video',
      blocks: [
        { id: 'blk00001', kind: 'about' },
        { id: 'blk00002', kind: 'links' },
        { id: 'blk00003', kind: 'text', variant: 'lead', text: 'Hi' },
        {
          id: 'blk00004',
          kind: 'text',
          variant: 'heading',
          level: 2,
          text: 'H',
        },
        { id: 'blk00004', kind: 'quote', variant: 'band', text: 'Q' },
        { kind: 'photo', imageId: 'not-a-uuid', alt: 'x' },
        { kind: 'supporters', id: 'blk00005' },
      ],
    },
    TODAY,
  );
  assert.equal(out.style, 'classic');
  assert.equal(out.accent, null);
  assert.equal(out.mode, 'light');
  assert.equal(out.cover, 'yours');
  assert.deepEqual(
    out.blocks.map((b) => [b.kind, b.variant]),
    [
      ['text', 'paragraph'],
      ['text', 'heading'],
      ['quote', undefined],
    ],
  );
  assert.equal(new Set(out.blocks.map((b) => b.id)).size, 3);
  assert.equal('level' in out.blocks[1], false);

  const many = resolveStudio(
    {
      ...VALID,
      blocks: [
        ...Array.from({ length: 30 }, photo),
        gallery(9),
        ...Array.from({ length: 5 }, video),
        events(8),
        services(14),
        ...Array.from({ length: 30 }, paragraph),
      ],
    },
    '2026-01-01',
  );
  assert.equal(studioDocumentSchema.safeParse(many).success, true);
  assert.equal(many.blocks.filter((b) => b.kind === 'photo').length, 24);
  assert.equal(many.blocks.filter((b) => b.kind === 'video').length, 3);
  assert.equal(many.blocks.length, 40);
});

test('resolveStudio hides events that have passed (Lagos date)', () => {
  const doc = withBlocks([
    {
      id: 'blk00001',
      kind: 'events',
      items: [
        { date: '2026-11-13', title: 'Past' },
        { date: TODAY, title: 'Today' },
      ],
    },
  ]);
  const out = resolveStudio(doc, TODAY);
  assert.deepEqual(
    out.blocks[0].items.map((i) => i.title),
    ['Today'],
  );
});

test('the default document is Classic with nothing chosen', () => {
  assert.deepEqual(defaultStudioDocument(), {
    v: 2,
    style: 'classic',
    accent: null,
    mode: 'light',
    cover: 'yours',
    blocks: [],
  });
  assert.equal(
    studioDocumentSchema.safeParse(defaultStudioDocument()).success,
    true,
  );
  assert.notEqual(defaultStudioDocument(), defaultStudioDocument());
  assert.deepEqual(resolveStudio(null, TODAY), defaultStudioDocument());
});

test('isClassicDefault is true only for it', () => {
  assert.equal(isClassicDefault(defaultStudioDocument()), true);
  const changed = [
    { style: 'clear' },
    { accent: 'ink' },
    { mode: 'auto' },
    { mode: 'dark' },
    { cover: 'plain' },
    { blocks: [paragraph()] },
  ];
  for (const c of changed)
    assert.equal(
      isClassicDefault({ ...defaultStudioDocument(), ...c }),
      false,
      JSON.stringify(c).slice(0, 40),
    );
  for (const style of STUDIO_STYLE_IDS.filter((s) => s !== 'classic'))
    assert.equal(
      isClassicDefault({ ...defaultStudioDocument(), style }),
      false,
    );
});

test('the Pro blocks and the images a document uses', () => {
  assert.deepEqual(
    [...STUDIO_PRO_BLOCKS],
    ['photo', 'gallery', 'video', 'services', 'events'],
  );
  const doc = withBlocks([
    paragraph(),
    photo(),
    {
      id: bid(),
      kind: 'gallery',
      images: [
        { imageId: '11111111-1111-4111-8111-111111111111', alt: 'a' },
        { imageId: IMG, alt: 'b' },
      ],
    },
    video(),
  ]);
  assert.deepEqual(
    [...studioImageIdsOf(doc)].sort(),
    [IMG, '11111111-1111-4111-8111-111111111111'].sort(),
  );
  assert.equal(studioImageIdsOf(defaultStudioDocument()).size, 0);
});
