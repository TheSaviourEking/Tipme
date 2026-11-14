// The shared fast-check generator for Page Studio documents (plan Task 3). The contracts
// property tests use it, and so will the Playwright render property test (Task 6).
//
// studioDocument({ valid: true }) makes documents the schema accepts: random brand colours, any
// font pair fontsOk allows, rows, columns and blocks up to the limits, and text from empty to the
// limit (biased to the limit, with long unbroken words, emoji, right-to-left and Yoruba text).
// studioDocument({ valid: false }) makes a valid one, then breaks exactly one rule.
// checkContext() makes the server facts the design check reads: image sizes and rendition
// bytes, video status and the profile's bio and link count.
import fc from 'fast-check';
import {
  STUDIO_FONTS,
  STUDIO_LIMITS,
  cleanStudioText,
  fontsOk,
  resolveStudio,
} from '../../dist/index.js';

/** Every generated event is on or after this day, so resolveStudio keeps it. */
export const TODAY = '2026-11-14';

export const IMAGE_POOL = Array.from(
  { length: 30 },
  (_, i) =>
    `0000${i.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`,
);
export const VIDEO_POOL = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtu.be/9bZkp7q19f0',
  'https://www.tiktok.com/@ifyplays/video/7301234567890123456',
  'https://audiomack.com/kemisings/song/lagos-rain',
];

const SAMPLES = [
  'Ọlápéjú Adébáyọ̀',
  'Ẹ̀kọ́ àti ìṣẹ́',
  'Chukwuemeka Ụzọ',
  'Supercalifragilisticexpialidocious',
  'https://example.com/a/very/long/link/without/spaces',
  '😀🎶🔥',
  'مرحبا بكم',
  'שלום',
  'Skin fade',
  'Live set, Lekki',
];

/** Text from empty to `max` code points, biased to the limit, already clean. */
export function text(max, { empty = true } = {}) {
  const word = fc.oneof(
    fc.constantFrom(...SAMPLES),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }),
    fc.integer({ min: 1, max: 70 }).map((n) => 'W'.repeat(n)),
  );
  return fc
    .oneof(
      { weight: 1, arbitrary: fc.constant('') },
      {
        weight: 3,
        arbitrary: fc
          .array(word, { minLength: 1, maxLength: 40 })
          .map((w) => w.join(' ')),
      },
      { weight: 2, arbitrary: fc.string({ unit: 'grapheme', maxLength: max }) },
    )
    .map((s) => {
      let out = cleanStudioText(s);
      while ([...out].length > max)
        out = cleanStudioText([...out].slice(0, max).join(''));
      return out;
    })
    .filter((s) => empty || s.length > 0);
}

const id = fc.stringMatching(/^[a-z0-9]{8}$/);
const hex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, '0')}`);
const pairs = STUDIO_FONTS.flatMap((h) =>
  STUDIO_FONTS.filter((b) => fontsOk(h.id, b.id)).map((b) => ({
    heading: h.id,
    body: b.id,
  })),
);
const L = STUDIO_LIMITS;
const kobo = fc
  .integer({ min: 1, max: 10_000_000 })
  .map((n) => String(n * 100));
const date = fc
  .integer({ min: 0, max: 400 })
  .map((d) =>
    new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
const imageRef = fc.record({
  imageId: fc.constantFrom(...IMAGE_POOL),
  alt: text(L.alt),
  decorative: fc.option(fc.constant(true), { nil: undefined }),
});
const withoutUndefined = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const block = fc.oneof(
  fc
    .record({
      kind: fc.constant('text'),
      variant: fc.constantFrom('heading', 'paragraph', 'lead'),
      level: fc.constantFrom(2, 3),
      t: text(L.paragraphText),
    })
    .map(({ variant, level, t }) => ({
      kind: 'text',
      variant,
      ...(variant === 'heading' ? { level } : {}),
      text: [...t]
        .slice(
          0,
          variant === 'heading'
            ? L.headingText
            : variant === 'lead'
              ? L.leadText
              : L.paragraphText,
        )
        .join(''),
    })),
  fc
    .record({
      kind: fc.constant('photo'),
      variant: fc.constantFrom('square', 'wide', 'tall', 'circle'),
      image: imageRef,
      caption: fc.option(text(L.caption, { empty: false }), { nil: undefined }),
    })
    .map(({ variant, image, caption }) =>
      withoutUndefined({ kind: 'photo', variant, ...image, caption }),
    ),
  fc
    .record({
      variant: fc.constantFrom('grid', 'strip', 'mosaic'),
      images: fc.array(imageRef, { maxLength: L.galleryImages }),
    })
    .map(({ variant, images }) => ({
      kind: 'gallery',
      variant,
      images: images.map(withoutUndefined),
    })),
  fc
    .record({
      url: fc.constantFrom(...VIDEO_POOL),
      caption: fc.option(text(L.caption, { empty: false }), { nil: undefined }),
    })
    .map((v) => withoutUndefined({ kind: 'video', variant: 'still', ...v })),
  fc
    .record({
      variant: fc.constantFrom('list', 'cards'),
      items: fc.array(
        fc
          .record({
            name: text(L.serviceName, { empty: false }),
            detail: fc.option(text(L.serviceDetail, { empty: false }), {
              nil: undefined,
            }),
            priceMinor: kobo,
            from: fc.option(fc.constant(true), { nil: undefined }),
          })
          .map(withoutUndefined),
        { maxLength: 4 },
      ),
    })
    .map((b) => ({ kind: 'services', ...b })),
  fc
    .record({
      variant: fc.constantFrom('list', 'cards'),
      items: fc.array(
        fc
          .record({
            date,
            time: fc.option(fc.constantFrom('09:00', '19:30', '21:00'), {
              nil: undefined,
            }),
            title: text(L.eventTitle, { empty: false }),
            place: fc.option(text(L.eventPlace, { empty: false }), {
              nil: undefined,
            }),
            note: fc.option(text(L.eventNote, { empty: false }), {
              nil: undefined,
            }),
          })
          .map(withoutUndefined),
        { maxLength: 3 },
      ),
    })
    .map((b) => ({ kind: 'events', ...b })),
  fc
    .constantFrom('buttons', 'icons')
    .map((variant) => ({ kind: 'links', variant })),
  fc
    .record({
      variant: fc.constantFrom('plain', 'band'),
      text: text(L.quoteText),
    })
    .map((b) => ({ kind: 'quote', ...b })),
  fc.constant({ kind: 'about', variant: 'plain' }),
);

const COLUMNS = { 1: ['1'], 2: ['1-1', '2-1', '1-2'], 3: ['1-1-1'] };
const row = fc.integer({ min: 1, max: 3 }).chain((n) =>
  fc.record({
    columns: fc.constantFrom(...COLUMNS[n]),
    spacing: fc.constantFrom('s', 'm', 'l'),
    background: fc.oneof(
      fc.constantFrom('page', 'card', 'colour', 'second'),
      fc.constantFrom(...IMAGE_POOL).map((photo) => ({ photo })),
    ),
    cells: fc.array(fc.array(block, { maxLength: L.blocksPerCell }), {
      minLength: n,
      maxLength: n,
    }),
  }),
);

const valid = fc
  .record({
    brand: fc.oneof(
      hex.map((a) => [a]),
      fc.tuple(hex, hex),
    ),
    mode: fc.constantFrom('light', 'dark', 'auto'),
    fonts: fc.constantFrom(...pairs),
    scale: fc.constantFrom('compact', 'standard', 'roomy'),
    corners: fc.constantFrom('square', 'soft', 'round'),
    rows: fc.array(row, { maxLength: L.rows }),
    ids: fc.uniqueArray(id, {
      minLength: L.rows + L.rows * 3 * L.blocksPerCell,
      maxLength: L.rows + L.rows * 3 * L.blocksPerCell,
    }),
  })
  .map(({ ids, rows, ...doc }) => {
    let next = 0;
    const raw = {
      v: 1,
      ...doc,
      brand: doc.brand[1] === undefined ? [doc.brand[0]] : doc.brand,
      rows: rows.map((r) => ({
        id: ids[next++],
        ...r,
        cells: r.cells.map((cell) =>
          cell.map((b) => ({ id: ids[next++], ...b })),
        ),
      })),
    };
    // The page-wide limits (40 blocks, 24 photos, 3 videos, one About and one Links) are met by
    // the resolver, which trims from the end: what it returns is what a person could have made.
    return resolveStudio(raw, TODAY);
  });

/** One rule broken per document, each of which the strict schema must refuse. */
const BREAKS = [
  (d) => ({ ...d, css: 'color: red' }),
  (d) => ({ ...d, brand: ['red'] }),
  (d) => ({ ...d, brand: ['#7A32F9'] }),
  (d) => ({ ...d, fonts: { heading: 'comic-sans', body: d.fonts.body } }),
  (d) => ({
    ...d,
    fonts: { heading: d.fonts.heading, body: 'dm-serif-display' },
  }),
  (d) => ({ ...d, mode: 'neon' }),
  (d) => ({ ...d, v: 2 }),
  (d) => ({
    ...d,
    rows: Array.from({ length: L.rows + 1 }, (_, i) => ({
      id: `row${String(i).padStart(5, '0')}`,
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [[]],
    })),
  }),
  (d) => ({
    ...d,
    rows: [
      {
        id: 'aaaaaaaa',
        columns: '1-1',
        spacing: 'm',
        background: 'page',
        cells: [[]],
      },
    ],
  }),
  (d) => ({
    ...d,
    rows: [
      {
        id: 'aaaaaaaa',
        columns: '1',
        spacing: 'm',
        background: 'page',
        cells: [[]],
        x: 10,
      },
    ],
  }),
  (d) => ({
    ...d,
    rows: [
      {
        id: 'aaaaaaaa',
        columns: '1',
        spacing: 'm',
        background: { photo: 'not-a-uuid' },
        cells: [[]],
      },
    ],
  }),
  (d) => ({
    ...d,
    rows: [
      {
        id: 'aaaaaaaa',
        columns: '1',
        spacing: 'm',
        background: 'page',
        cells: [[{ id: 'aaaaaaaa', kind: 'about', variant: 'plain' }]],
      },
    ],
  }),
  (d) =>
    withBlock(d, {
      kind: 'text',
      variant: 'heading',
      level: 2,
      text: 'x',
      fontSize: 40,
    }),
  (d) =>
    withBlock(d, { kind: 'text', variant: 'paragraph', level: 2, text: 'x' }),
  (d) =>
    withBlock(d, {
      kind: 'text',
      variant: 'heading',
      level: 2,
      text: 'x'.repeat(L.headingText + 1),
    }),
  (d) =>
    withBlock(d, {
      kind: 'text',
      variant: 'heading',
      level: 2,
      text: 'two\nlines',
    }),
  (d) =>
    withBlock(d, {
      kind: 'text',
      variant: 'heading',
      level: 2,
      text: 'Hi‮evil',
    }),
  (d) =>
    withBlock(d, {
      kind: 'services',
      variant: 'list',
      items: [{ name: 'Cut', priceMinor: '150' }],
    }),
  (d) =>
    withBlock(d, {
      kind: 'services',
      variant: 'list',
      items: [{ name: 'Cut', priceMinor: '0' }],
    }),
  (d) =>
    withBlock(d, {
      kind: 'services',
      variant: 'list',
      items: [{ name: 'Cut', priceMinor: 500 }],
    }),
  (d) =>
    withBlock(d, {
      kind: 'events',
      variant: 'list',
      items: [{ date: '2026-02-30', title: 'Gig' }],
    }),
  (d) =>
    withBlock(d, {
      kind: 'video',
      variant: 'still',
      url: 'https://www.instagram.com/reel/abc/',
    }),
  (d) => withBlock(d, { kind: 'supporters', variant: 'names' }),
  (d) => withBlock(d, { kind: 'embed', variant: 'html', html: '<script>' }),
  (d) =>
    withBlock(d, {
      kind: 'gallery',
      variant: 'grid',
      images: Array.from({ length: L.galleryImages + 1 }, () => ({
        imageId: IMAGE_POOL[0],
        alt: 'a',
      })),
    }),
];

/** `d` with one extra one-column row holding `b`. */
export function withBlock(d, b) {
  return {
    ...d,
    rows: [
      {
        id: 'zzzzzzz0',
        columns: '1',
        spacing: 'm',
        background: 'page',
        cells: [[{ id: 'zzzzzzz1', ...b }]],
      },
    ],
  };
}

export function studioDocument({ valid: wanted = true } = {}) {
  if (wanted) return valid;
  return fc
    .tuple(valid, fc.integer({ min: 0, max: BREAKS.length - 1 }))
    .map(([d, i]) => BREAKS[i](d));
}

export function checkContext() {
  const size = fc.record({
    width: fc.integer({ min: 300, max: 4000 }),
    height: fc.integer({ min: 300, max: 4000 }),
    perPixel: fc.double({ min: 0.02, max: 0.5, noNaN: true }),
  });
  return fc
    .record({
      sizes: fc.array(size, {
        minLength: IMAGE_POOL.length,
        maxLength: IMAGE_POOL.length,
      }),
      videos: fc.array(fc.constantFrom('ok', 'gone', 'unknown'), {
        minLength: VIDEO_POOL.length,
        maxLength: VIDEO_POOL.length,
      }),
      bio: fc.boolean(),
      links: fc.integer({ min: 0, max: 8 }),
    })
    .map(({ sizes, videos, bio, links }) => ({
      images: Object.fromEntries(
        IMAGE_POOL.map((imageId, i) => [imageId, imageFacts(sizes[i])]),
      ),
      videos: Object.fromEntries(VIDEO_POOL.map((url, i) => [url, videos[i]])),
      profile: { bio, links },
    }));
}

/** Facts for one stored image: renditions per shape at 480/960/1440 wide, never upscaled. */
export function imageFacts({ width, height, perPixel = 0.08 }) {
  const bytes = {};
  for (const [shape, aspect] of Object.entries({
    square: 1,
    wide: 16 / 9,
    tall: 4 / 5,
    strip: 3.73,
  }))
    for (const w of [480, 960, 1440]) {
      const usable = Math.min(width, height * aspect);
      if (w > usable && w !== 480) continue;
      bytes[`${shape}-${w}`] = Math.round(w * (w / aspect) * perPixel);
    }
  return { width, height, bytes };
}
