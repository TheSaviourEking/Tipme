import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  STUDIO_DEFAULT_FONTS,
  STUDIO_EMBED_ORIGINS,
  STUDIO_LIMITS,
  STUDIO_SUPPORTER_WALL,
  STUDIO_VIDEO_SITES,
  cleanStudioParagraph,
  cleanStudioText,
  defaultStudioDocument,
  embedUrl,
  parseVideoLink,
  resolveStudio,
  studioDocumentSchema,
} from '../dist/index.js';
import { regressions, runs, seed } from './support/pbt.mjs';
import {
  IMAGE_POOL,
  TODAY,
  studioDocument,
  withBlock,
} from './support/studio-arbitrary.mjs';

const VALID = {
  v: 1,
  brand: ['#1d4e89'],
  mode: 'light',
  fonts: { heading: 'fraunces', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows: [
    {
      id: 'row00001',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'blk00001',
            kind: 'text',
            variant: 'heading',
            level: 2,
            text: 'Hello',
          },
        ],
      ],
    },
  ],
};
const ok = (d) => studioDocumentSchema.safeParse(d).success;
const withRow = (extra) => ({
  ...VALID,
  rows: [{ ...VALID.rows[0], ...extra }],
});
const rowOf = (cells, columns = '1') => ({
  id: 'row00009',
  columns,
  spacing: 'm',
  background: 'page',
  cells,
});
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const bid = (i) => `b${String(i).padStart(7, '0')}`;
const rid = (i) => `r${String(i).padStart(7, '0')}`;

test('the valid example parses', () => {
  assert.equal(ok(VALID), true);
});

test('no size, position or CSS can be stored', () => {
  for (const bad of [
    { ...VALID, css: 'x' },
    withBlock(VALID, {
      kind: 'text',
      variant: 'heading',
      level: 2,
      text: 'x',
      fontSize: 40,
    }),
    withRow({ x: 10 }),
    withRow({ background: { photo: IMAGE_POOL[0], position: 'top' } }),
    withRow({ background: '#ff0000' }),
  ])
    assert.equal(ok(bad), false, JSON.stringify(bad).slice(0, 120));
});

test('three font families, or a display font as body, are refused', () => {
  assert.equal(
    ok({ ...VALID, fonts: { heading: 'fraunces', body: 'dm-serif-display' } }),
    false,
  );
  assert.equal(
    ok({
      ...VALID,
      fonts: { heading: 'fraunces', body: 'inter', extra: 'nunito' },
    }),
    false,
  );
  assert.equal(
    ok({ ...VALID, fonts: { heading: 'comic-sans', body: 'inter' } }),
    false,
  );
  assert.equal(
    ok({ ...VALID, fonts: { heading: 'nunito', body: 'nunito' } }),
    true,
  );
});

test('brand colours are one or two lower-case #rrggbb; a second-colour row needs a second colour', () => {
  assert.equal(ok({ ...VALID, brand: ['#1d4e89', '#ff7a59'] }), true);
  for (const brand of [
    [],
    ['#1D4E89'],
    ['red'],
    ['#1d4e89', '#ff7a59', '#000000'],
  ])
    assert.equal(ok({ ...VALID, brand }), false, String(brand));
  assert.equal(ok(withRow({ background: 'second' })), false);
  assert.equal(
    ok({ ...withRow({ background: 'second' }), brand: ['#1d4e89', '#ff7a59'] }),
    true,
  );
});

test('limits: 12 rows, 3 blocks per cell, 40 blocks, 9 photos per gallery, 24 per page, 3 videos, 6 events, 12 services', () => {
  const L = STUDIO_LIMITS;
  const heading = (i) => ({
    id: bid(i),
    kind: 'text',
    variant: 'heading',
    level: 2,
    text: 'x',
  });
  const rows = (n, perCell, cols = '1-1-1') =>
    many(n, (r) => ({
      id: rid(r),
      columns: cols,
      spacing: 'm',
      background: 'page',
      cells: many(cols.split('-').length, (c) =>
        many(perCell, (k) => heading(r * 100 + c * 10 + k)),
      ),
    }));
  assert.equal(ok({ ...VALID, rows: rows(L.rows, 1, '1') }), true);
  assert.equal(ok({ ...VALID, rows: rows(L.rows + 1, 1, '1') }), false);
  assert.equal(
    ok({ ...VALID, rows: rows(1, L.blocksPerCell + 1, '1') }),
    false,
  );
  // 13 rows × 3 cells is past 12 rows; 12 rows of 1-1-1 with 2 blocks each is 72 > 40.
  assert.equal(ok({ ...VALID, rows: rows(4, 3) }), true); // 36
  assert.equal(ok({ ...VALID, rows: rows(5, 3) }), false); // 45
  const image = (i) => ({
    imageId: IMAGE_POOL[i % IMAGE_POOL.length],
    alt: 'a',
  });
  assert.equal(
    ok(
      withBlock(VALID, {
        kind: 'gallery',
        variant: 'grid',
        images: many(L.galleryImages, image),
      }),
    ),
    true,
  );
  assert.equal(
    ok(
      withBlock(VALID, {
        kind: 'gallery',
        variant: 'grid',
        images: many(L.galleryImages + 1, image),
      }),
    ),
    false,
  );
  const galleries = (n) => ({
    ...VALID,
    rows: [
      rowOf(
        many(3, (c) =>
          many(Math.min(3, n), (k) => ({
            id: bid(c * 10 + k),
            kind: 'gallery',
            variant: 'grid',
            images: many(L.galleryImages, image),
          })),
        ),
        '1-1-1',
      ),
    ],
  });
  assert.equal(ok(galleries(1)), false); // 3 × 9 = 27 photos > 24
  const video = (i) => ({
    id: bid(i),
    kind: 'video',
    variant: 'still',
    url: 'https://youtu.be/dQw4w9WgXcQ',
  });
  assert.equal(ok({ ...VALID, rows: [rowOf([many(3, video)])] }), true);
  assert.equal(
    ok({ ...VALID, rows: [rowOf([many(3, video), [video(9)]], '1-1')] }),
    false,
  );
  const events = (i, n) => ({
    id: bid(i),
    kind: 'events',
    variant: 'list',
    items: many(n, () => ({ date: '2026-12-01', title: 'Gig' })),
  });
  assert.equal(ok({ ...VALID, rows: [rowOf([[events(1, 6)]])] }), true);
  assert.equal(
    ok({ ...VALID, rows: [rowOf([[events(1, 4), events(2, 3)]])] }),
    false,
  );
  const services = (i, n) => ({
    id: bid(i),
    kind: 'services',
    variant: 'list',
    items: many(n, () => ({ name: 'Cut', priceMinor: '500000' })),
  });
  assert.equal(ok({ ...VALID, rows: [rowOf([[services(1, 12)]])] }), true);
  assert.equal(
    ok({ ...VALID, rows: [rowOf([[services(1, 7), services(2, 6)]])] }),
    false,
  );
  assert.equal(
    ok(
      withBlock(VALID, {
        kind: 'text',
        variant: 'heading',
        level: 2,
        text: 'x'.repeat(L.headingText),
      }),
    ),
    true,
  );
  assert.equal(
    ok(
      withBlock(VALID, {
        kind: 'text',
        variant: 'heading',
        level: 2,
        text: 'ẹ'.repeat(L.headingText),
      }),
    ),
    true,
    'counted in code points',
  );
  assert.equal(
    ok(
      withBlock(VALID, {
        kind: 'text',
        variant: 'heading',
        level: 2,
        text: 'x'.repeat(L.headingText + 1),
      }),
    ),
    false,
  );
});

test('About and Links appear at most once; ids are unique', () => {
  const about = (i) => ({ id: bid(i), kind: 'about', variant: 'plain' });
  const links = (i) => ({ id: bid(i), kind: 'links', variant: 'buttons' });
  assert.equal(ok({ ...VALID, rows: [rowOf([[about(1), links(2)]])] }), true);
  assert.equal(ok({ ...VALID, rows: [rowOf([[about(1), about(2)]])] }), false);
  assert.equal(
    ok({ ...VALID, rows: [rowOf([[links(1)], [links(2)]], '1-1')] }),
    false,
  );
  assert.equal(ok({ ...VALID, rows: [rowOf([[about(1), links(1)]])] }), false);
  assert.equal(
    ok({ ...VALID, rows: [{ ...rowOf([[about(1)]]), id: bid(1) }] }),
    false,
  );
  assert.equal(
    ok({ ...VALID, rows: [{ ...rowOf([[about(1)]]), id: 'Row-0001' }] }),
    false,
  );
});

test('prices are whole naira kobo strings', () => {
  const price = (priceMinor) =>
    ok(
      withBlock(VALID, {
        kind: 'services',
        variant: 'list',
        items: [{ name: 'Cut', priceMinor }],
      }),
    );
  assert.equal(price('100'), true);
  assert.equal(price('800000'), true);
  assert.equal(price('1000000000'), true);
  for (const bad of [
    '150',
    '0',
    '1000000100',
    '-500',
    '05000',
    '50.00',
    5000,
    '',
  ])
    assert.equal(price(bad), false, String(bad));
});

test('events: real dates and 24-hour times; text only, no links', () => {
  const ev = (item) =>
    ok(
      withBlock(VALID, {
        kind: 'events',
        variant: 'list',
        items: [{ title: 'Gig', ...item }],
      }),
    );
  assert.equal(ev({ date: '2026-12-01', time: '19:30' }), true);
  assert.equal(ev({ date: '2028-02-29' }), true);
  for (const bad of [
    { date: '2026-02-30' },
    { date: '2026-13-01' },
    { date: '1/12/2026' },
    { date: '2026-12-01', time: '7pm' },
    { date: '2026-12-01', time: '24:00' },
    { date: '2026-12-01', url: 'https://x' },
  ])
    assert.equal(ev(bad), false, JSON.stringify(bad));
});

test('paragraphs keep up to 3 paragraph breaks; other text is one line', () => {
  const para = (text) =>
    ok(withBlock(VALID, { kind: 'text', variant: 'paragraph', text }));
  assert.equal(para('One.\n\nTwo.\n\nThree.\n\nFour.'), true);
  assert.equal(para('One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.'), false);
  assert.equal(para('One.\nTwo.'), false);
  assert.equal(
    cleanStudioParagraph(
      ' One.\r\n\r\n\r\nTwo.\nstill two \n\n\n\nThree.\n\n4\n\n5 ',
    ),
    'One.\n\nTwo. still two\n\nThree.\n\n4',
  );
});

test('studio text is cleaned of control and bidi characters', () => {
  assert.equal(cleanStudioText(' Hi‮evil\u0007 '), 'Hievil');
  assert.equal(cleanStudioText('a⁦b⁩c\u0085d'), 'abcd');
  assert.equal(cleanStudioText('two\nlines\tand tab'), 'two lines and tab');
  assert.equal(cleanStudioText('Ọlá'), 'Ọlá'.normalize('NFC'));
  assert.equal(cleanStudioText('é'), 'é', 'NFC');
});

test('the heading level belongs to headings only', () => {
  assert.equal(
    ok(withBlock(VALID, { kind: 'text', variant: 'heading', text: 'x' })),
    false,
  );
  assert.equal(
    ok(
      withBlock(VALID, {
        kind: 'text',
        variant: 'heading',
        level: 1,
        text: 'x',
      }),
    ),
    false,
  );
  assert.equal(
    ok(
      withBlock(VALID, { kind: 'text', variant: 'lead', level: 3, text: 'x' }),
    ),
    false,
  );
});

test('the supporter wall is refused until its own switch (Task 13)', () => {
  assert.equal(STUDIO_SUPPORTER_WALL, false);
  assert.equal(
    ok(withBlock(VALID, { kind: 'supporters', variant: 'names' })),
    false,
  );
});

test('generated valid documents parse, and broken ones never do', () => {
  fc.assert(
    fc.property(studioDocument({ valid: true }), (d) => {
      const r = studioDocumentSchema.safeParse(d);
      assert.equal(r.success, true, JSON.stringify(r.error?.issues?.[0]));
    }),
    { numRuns: runs(2000), seed: seed() },
  );
  fc.assert(
    fc.property(studioDocument({ valid: false }), (d) =>
      assert.equal(ok(d), false),
    ),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('resolveStudio never throws, is idempotent and always yields a schema-valid document', () => {
  for (const raw of regressions('resolve')) {
    const r = resolveStudio(raw, TODAY);
    assert.equal(ok(r), true);
    assert.deepEqual(resolveStudio(r, TODAY), r);
  }
  fc.assert(
    fc.property(
      fc.oneof(
        fc.anything(),
        studioDocument({ valid: false }),
        studioDocument({ valid: true }),
      ),
      (g) => {
        const r = resolveStudio(g, TODAY);
        const parsed = studioDocumentSchema.safeParse(r);
        assert.equal(
          parsed.success,
          true,
          JSON.stringify(parsed.error?.issues?.[0]),
        );
        assert.deepEqual(resolveStudio(r, TODAY), r);
      },
    ),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('every generated valid document survives a JSON round trip, and resolveStudio leaves it as it is', () => {
  fc.assert(
    fc.property(studioDocument({ valid: true }), (d) => {
      assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
      assert.deepEqual(resolveStudio(d, TODAY), d);
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('resolveStudio keeps a page readable after a font is retired', () => {
  const r = resolveStudio(
    { ...VALID, fonts: { heading: 'lora', body: 'libre-baskerville' } },
    TODAY,
  );
  assert.deepEqual(r.fonts, STUDIO_DEFAULT_FONTS);
  assert.deepEqual(r.rows, VALID.rows);
  const display = resolveStudio(
    { ...VALID, fonts: { heading: 'fraunces', body: 'dm-serif-display' } },
    TODAY,
  );
  assert.deepEqual(display.fonts, {
    heading: 'fraunces',
    body: STUDIO_DEFAULT_FONTS.body,
  });
});

test('resolveStudio replaces what it cannot use and trims from the end', () => {
  assert.deepEqual(
    resolveStudio({ ...VALID, brand: ['nope', 'also'] }, TODAY).brand,
    ['#7a32f9'],
  );
  assert.deepEqual(
    resolveStudio({ ...VALID, brand: ['#1D4E89'] }, TODAY).brand,
    ['#1d4e89'],
  );
  assert.equal(resolveStudio({ ...VALID, mode: 'neon' }, TODAY).mode, 'light');
  const withUnknown = {
    ...VALID,
    rows: [
      {
        ...VALID.rows[0],
        cells: [
          [
            { id: 'blk00002', kind: 'embed', html: '<b>' },
            ...VALID.rows[0].cells[0],
          ],
        ],
      },
    ],
  };
  assert.deepEqual(resolveStudio(withUnknown, TODAY).rows, VALID.rows);
  const rows = many(15, (i) => ({
    ...VALID.rows[0],
    id: rid(i),
    cells: [[{ ...VALID.rows[0].cells[0][0], id: bid(i) }]],
  }));
  assert.deepEqual(
    resolveStudio({ ...VALID, rows }, TODAY).rows.map((r) => r.id),
    rows.slice(0, 12).map((r) => r.id),
  );
  const long = resolveStudio(
    withBlock(VALID, {
      kind: 'text',
      variant: 'heading',
      level: 2,
      text: ` ${'y'.repeat(200)}‮ `,
    }),
    TODAY,
  );
  assert.equal(
    long.rows[0].cells[0][0].text,
    'y'.repeat(STUDIO_LIMITS.headingText),
  );
  assert.equal(resolveStudio(null, TODAY).rows.length, 0);
  assert.equal(resolveStudio('<script>', TODAY).v, 1);
});

test('resolveStudio hides events that have passed (Lagos date)', () => {
  const doc = withBlock(VALID, {
    kind: 'events',
    variant: 'list',
    items: [
      { date: '2026-11-13', title: 'Yesterday' },
      { date: '2026-11-14', title: 'Today' },
      { date: '2026-11-15', title: 'Tomorrow' },
    ],
  });
  const titles = resolveStudio(doc, '2026-11-14').rows[0].cells[0][0].items.map(
    (e) => e.title,
  );
  assert.deepEqual(titles, ['Today', 'Tomorrow']);
});

test('video links: only allow-listed sites; Instagram and look-alike hosts refused', () => {
  assert.deepEqual(STUDIO_VIDEO_SITES, ['youtube', 'tiktok', 'audiomack']);
  assert.deepEqual(parseVideoLink('https://youtu.be/dQw4w9WgXcQ'), {
    site: 'youtube',
    id: 'dQw4w9WgXcQ',
  });
  assert.deepEqual(
    parseVideoLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'),
    { site: 'youtube', id: 'dQw4w9WgXcQ' },
  );
  assert.deepEqual(parseVideoLink('https://m.youtube.com/shorts/dQw4w9WgXcQ'), {
    site: 'youtube',
    id: 'dQw4w9WgXcQ',
  });
  assert.deepEqual(
    parseVideoLink(
      'https://www.tiktok.com/@ifyplays/video/7301234567890123456',
    ),
    { site: 'tiktok', id: '7301234567890123456' },
  );
  assert.deepEqual(
    parseVideoLink('https://audiomack.com/kemisings/song/lagos-rain'),
    { site: 'audiomack', id: 'kemisings/song/lagos-rain' },
  );
  for (const bad of [
    'https://www.instagram.com/reel/abc/',
    'https://youtube.com.evil.example/watch?v=x',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://evil.example/youtu.be/dQw4w9WgXcQ',
    'http://youtu.be/dQw4w9WgXcQ',
    'https://user:pw@youtu.be/dQw4w9WgXcQ',
    'https://youtu.be:8443/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.tiktok.com/@x/video/abc',
    'https://audiomack.com/kemisings/album/lagos',
    'javascript:alert(1)',
    'not a url',
  ])
    assert.equal(parseVideoLink(bad), null, bad);
});

test('embeds load from the listed origins only', () => {
  assert.equal(
    embedUrl({ site: 'youtube', id: 'dQw4w9WgXcQ' }),
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  );
  assert.equal(
    embedUrl({ site: 'tiktok', id: '7301234567890123456' }),
    'https://www.tiktok.com/embed/v2/7301234567890123456',
  );
  assert.equal(
    embedUrl({ site: 'audiomack', id: 'kemisings/song/lagos-rain' }),
    'https://audiomack.com/embed/kemisings/song/lagos-rain',
  );
  for (const v of [
    { site: 'youtube', id: 'dQw4w9WgXcQ' },
    { site: 'tiktok', id: '1' },
    { site: 'audiomack', id: 'a/song/b' },
  ])
    assert.ok(STUDIO_EMBED_ORIGINS.includes(new URL(embedUrl(v)).origin));
});

test('defaultStudioDocument is a valid starter page in the default fonts', () => {
  for (const profile of [
    { bio: 'Singer, Lagos', links: 3 },
    { bio: null, links: 0 },
    { bio: '', links: 2 },
  ]) {
    const d = defaultStudioDocument(profile);
    assert.equal(ok(d), true);
    assert.deepEqual(d.fonts, STUDIO_DEFAULT_FONTS);
    assert.equal(
      d.rows.some((r) => r.cells.flat().some((b) => b.kind === 'about')),
      Boolean(profile.bio),
    );
    assert.equal(
      d.rows.some((r) => r.cells.flat().some((b) => b.kind === 'links')),
      profile.links > 0,
    );
  }
});
