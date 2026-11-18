import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  STUDIO_ACCENTS,
  hexToOklch,
  migrateStudioV1,
  resolveStudio,
  resolveStudioV1,
  studioDocumentSchema,
} from '../dist/index.js';
import {
  EXAMPLE_CONTEXT,
  IFY,
  KEMI,
  SULE,
} from './fixtures/studio-examples.mjs';
import { TODAY } from './support/studio-arbitrary.mjs';

const json = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const FIXTURE = json('./fixtures/studio-v1-to-v2.json');
const REGRESSIONS = json('./fixtures/studio-regressions.json');

const v1 = ({ heading = 'manrope', body = 'inter', ...rest } = {}) => ({
  v: 1,
  brand: ['#7a32f9'],
  mode: 'light',
  fonts: { heading, body },
  scale: 'standard',
  corners: 'soft',
  rows: [],
  ...rest,
});
const migrate = (doc) => resolveStudio(doc, TODAY);
const cell = (...blocks) => blocks;
const row = (id, cells, extra = {}) => ({
  id,
  columns: cells.length === 1 ? '1' : cells.length === 2 ? '1-1' : '1-1-1',
  spacing: 'm',
  background: 'page',
  cells,
  ...extra,
});
const text = (id, text, variant = 'paragraph', level) => ({
  id,
  kind: 'text',
  variant,
  ...(level ? { level } : {}),
  text,
});

test('a heading in source-serif-4 or fraunces becomes Journal', () => {
  for (const heading of ['source-serif-4', 'fraunces'])
    assert.equal(migrate(v1({ heading, body: 'inter' })).style, 'journal');
  // Journal wins over dark mode.
  assert.equal(
    migrate(v1({ heading: 'fraunces', mode: 'dark' })).style,
    'journal',
  );
});

test('otherwise dark mode becomes Stage', () => {
  assert.equal(migrate(v1({ mode: 'dark' })).style, 'stage');
  assert.equal(
    migrate(v1({ mode: 'dark', heading: 'dm-serif-display', body: 'manrope' }))
      .style,
    'stage',
  );
});

test('otherwise DM Serif Display with Manrope becomes Classic', () => {
  assert.equal(
    migrate(v1({ heading: 'dm-serif-display', body: 'manrope' })).style,
    'classic',
  );
  // Light and auto both reach Classic; only the pair matters.
  assert.equal(
    migrate(v1({ heading: 'dm-serif-display', body: 'manrope', mode: 'auto' }))
      .style,
    'classic',
  );
});

test('anything else becomes Clear', () => {
  assert.equal(migrate(v1({})).style, 'clear');
  assert.equal(
    migrate(v1({ heading: 'dm-serif-display', body: 'inter' })).style,
    'clear',
  );
  assert.equal(
    migrate(v1({ heading: 'outfit', body: 'inter' })).style,
    'clear',
  );
});

test('brand[0] becomes the nearest accent by OKLab; greys become Ink; the old default purple becomes no accent', () => {
  const accent = (hex) => migrate(v1({ brand: [hex] })).accent;
  assert.equal(accent('#7a32f9'), null);
  assert.equal(accent('#777777'), 'ink');
  assert.equal(accent('#000000'), 'ink');
  assert.equal(accent('#ffffff'), 'ink');
  // Navy: OKLab distance to Lagoon 0.1133, Blue 0.1203, Violet 0.1586 at their light fills.
  assert.equal(accent('#1d4e89'), 'lagoon');
  // A colour that is exactly an accent's light fill maps to it.
  for (const [id, a] of Object.entries(STUDIO_ACCENTS))
    if (hexToOklch(a.light.fill).c >= 0.04)
      assert.equal(accent(a.light.fill), id, id);
  // The second brand colour is ignored.
  assert.equal(migrate(v1({ brand: ['#7a32f9', '#00707a'] })).accent, null);
});

test('mode is kept, cover is Your cover, rows flatten in reading order', () => {
  for (const mode of ['light', 'dark', 'auto'])
    assert.equal(migrate(v1({ mode })).mode, mode);
  const doc = migrate(
    v1({
      rows: [
        row('row00001', [
          cell(text('a0000001', 'A1'), text('a0000002', 'A2')),
          cell(text('b0000001', 'B1')),
        ]),
        row('row00002', [cell(text('c0000001', 'C1'))]),
        row('row00003', [
          cell(text('d0000001', 'D1')),
          cell(text('d0000002', 'D2'), text('d0000003', 'D3')),
          cell(text('d0000004', 'D4')),
        ]),
      ],
    }),
  );
  assert.equal(doc.cover, 'yours');
  assert.deepEqual(
    doc.blocks.map((b) => b.text),
    ['A1', 'A2', 'B1', 'C1', 'D1', 'D2', 'D3', 'D4'],
  );
  assert.equal(studioDocumentSchema.safeParse(doc).success, true);
});

test('About, Links, supporters and row photo backgrounds are dropped; lead becomes paragraph; variants and levels go', () => {
  const IMG = '00000000-0000-4000-8000-000000000000';
  const doc = migrate(
    v1({
      rows: [
        row(
          'row00001',
          [
            cell(
              { id: 'abt00001', kind: 'about', variant: 'plain' },
              { id: 'lnk00001', kind: 'links', variant: 'buttons' },
              text('lead0001', 'Lead in', 'lead'),
            ),
          ],
          { background: { photo: IMG } },
        ),
        row('row00002', [
          cell(
            text('head0001', 'Heading', 'heading', 3),
            {
              id: 'pho00001',
              kind: 'photo',
              variant: 'circle',
              imageId: IMG,
              alt: 'Me',
              caption: 'Cap',
            },
            { id: 'qte00001', kind: 'quote', variant: 'band', text: 'Quote' },
          ),
        ]),
        row('row00003', [
          cell(
            {
              id: 'gal00001',
              kind: 'gallery',
              variant: 'mosaic',
              images: [{ imageId: IMG, alt: 'a' }],
            },
            {
              id: 'vid00001',
              kind: 'video',
              variant: 'still',
              url: 'https://youtu.be/9bZkp7q19f0',
            },
            {
              id: 'svc00001',
              kind: 'services',
              variant: 'cards',
              items: [{ name: 'Cut', priceMinor: '500000' }],
            },
          ),
          cell({
            id: 'evt00001',
            kind: 'events',
            variant: 'cards',
            items: [{ date: '2027-01-01', title: 'Show' }],
          }),
        ]),
      ],
    }),
  );
  assert.deepEqual(
    doc.blocks.map((b) => [b.id, b.kind, b.variant]),
    [
      ['lead0001', 'text', 'paragraph'],
      ['head0001', 'text', 'heading'],
      ['pho00001', 'photo', undefined],
      ['qte00001', 'quote', undefined],
      ['gal00001', 'gallery', undefined],
      ['vid00001', 'video', undefined],
      ['svc00001', 'services', undefined],
      ['evt00001', 'events', undefined],
    ],
  );
  for (const b of doc.blocks) {
    assert.equal('variant' in b && b.kind !== 'text', false, b.kind);
    assert.equal('level' in b, false);
  }
  assert.equal(doc.blocks[2].caption, 'Cap');
  assert.equal(studioDocumentSchema.safeParse(doc).success, true);
  assert.equal(JSON.stringify(doc).includes('about'), false);
});

const regressionDocs = () =>
  Object.entries(REGRESSIONS).flatMap(([group, list]) =>
    list.filter((e) => e.doc).map((e, i) => [`${group}[${i}]`, e.doc]),
  );

test('converted fixtures are pinned', () => {
  const sources = {
    kemi: KEMI,
    sule: SULE,
    ify: IFY,
    ...Object.fromEntries(
      regressionDocs().map(([k, d]) => [`regression:${k}`, d]),
    ),
  };
  assert.deepEqual(Object.keys(FIXTURE).sort(), Object.keys(sources).sort());
  assert.ok(EXAMPLE_CONTEXT);
  for (const [name, doc] of Object.entries(sources)) {
    const converted = resolveStudio(doc, TODAY);
    assert.deepEqual(converted, FIXTURE[name], name);
    assert.equal(studioDocumentSchema.safeParse(converted).success, true, name);
    assert.deepEqual(resolveStudio(converted, TODAY), converted, name);
  }
});

test('migrateStudioV1 itself reads the same table, and resolveStudio is the same as migrating a resolved document', () => {
  const doc = v1({ heading: 'dm-serif-display', body: 'manrope' });
  assert.equal(migrateStudioV1(doc).style, 'classic');
  assert.equal(migrateStudioV1(resolveStudioV1(v1({}), TODAY)).style, 'clear');
  assert.deepEqual(
    resolveStudio(KEMI, TODAY),
    resolveStudio(migrateStudioV1(resolveStudioV1(KEMI, TODAY)), TODAY),
  );
});
