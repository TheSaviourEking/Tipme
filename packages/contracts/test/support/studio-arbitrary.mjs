// The shared fast-check generator for Page Studio documents (plan Task 3). The contracts
// property tests use it, and so will the Playwright render property test (Task 6).
//
// studioDocumentV1Arb({ valid: true }) makes documents the schema accepts: random brand colours, any
// font pair fontsOk allows, rows, columns and blocks up to the limits, and text from empty to the
// limit (biased to the limit, with long unbroken words, emoji, right-to-left and Yoruba text).
// studioDocumentV1Arb({ valid: false }) makes a valid one, then breaks exactly one rule.
// studioDocumentArb({ valid }) is the same for the v2 document: a style, an accent (or none), a mode,
// a cover the style offers and up to 45 blocks of the eight v2 kinds, trimmed to the limits.
// checkContext() makes the server facts the design check reads: image sizes and rendition
// bytes, video status and the profile's bio and link count.
import fc from 'fast-check';
import {
  STUDIO_FIX_NEEDS_INPUT,
  STUDIO_FONTS,
  STUDIO_ACCENT_IDS,
  STUDIO_LIMITS,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  applyStudioFixV1,
  checkDesignV1,
  cleanStudioText,
  fontsOk,
  resolveStudioV1,
} from '../../dist/index.js';

/** fast-check itself, for specs outside this package (the Playwright render test). */
export { fc };

/** Every generated event is on or after this day, so resolveStudioV1 keeps it. */
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
    return resolveStudioV1(raw, TODAY);
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

export function studioDocumentV1Arb({ valid: wanted = true } = {}) {
  if (wanted) return valid;
  return fc
    .tuple(valid, fc.integer({ min: 0, max: BREAKS.length - 1 }))
    .map(([d, i]) => BREAKS[i](d));
}

function cut(t, max) {
  let out = cleanStudioText(t);
  while ([...out].length > max)
    out = cleanStudioText([...out].slice(0, max).join(''));
  return out;
}

const blockV2 = fc.oneof(
  fc
    .record({
      variant: fc.constantFrom('heading', 'paragraph'),
      t: text(L.paragraphText),
    })
    .map(({ variant, t }) => ({
      kind: 'text',
      variant,
      // Cutting at the limit can leave a trailing space, which the schema's clean-line rule
      // refuses, so clean again after each cut (as the schema's own text rules do).
      text: cut(t, variant === 'heading' ? L.headingText : L.paragraphText),
    })),
  fc
    .record({
      image: imageRef,
      caption: fc.option(text(L.caption, { empty: false }), { nil: undefined }),
    })
    .map(({ image, caption }) =>
      withoutUndefined({ kind: 'photo', ...image, caption }),
    ),
  fc.array(imageRef, { maxLength: L.galleryImages }).map((images) => ({
    kind: 'gallery',
    images: images.map(withoutUndefined),
  })),
  fc
    .record({
      url: fc.constantFrom(...VIDEO_POOL),
      caption: fc.option(text(L.caption, { empty: false }), { nil: undefined }),
    })
    .map((v) => withoutUndefined({ kind: 'video', ...v })),
  fc
    .array(
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
    )
    .map((items) => ({ kind: 'services', items })),
  fc
    .array(
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
    )
    .map((items) => ({ kind: 'events', items })),
  text(L.quoteText).map((t) => ({ kind: 'quote', text: t })),
);

const BLOCKS_V2 = 45;

/**
 * Keeps blocks, in order, while the page-wide totals hold (40 blocks, 24 photos, 3 videos, 6
 * events, 12 services); a block that would pass one is left out. This is the generator's own
 * budget: valid documents are built without calling resolveStudio, so the resolver is tested
 * against them rather than against its own output.
 */
function withinBudget(blocks) {
  const left = {
    blocks: L.blocks,
    images: L.pageImages,
    videos: L.videos,
    events: L.events,
    services: L.services,
  };
  const need = (b) => ({
    blocks: 1,
    images: b.kind === 'photo' ? 1 : b.kind === 'gallery' ? b.images.length : 0,
    videos: b.kind === 'video' ? 1 : 0,
    events: b.kind === 'events' ? b.items.length : 0,
    services: b.kind === 'services' ? b.items.length : 0,
  });
  return blocks.filter((b) => {
    const n = need(b);
    if (Object.keys(left).some((k) => n[k] > left[k])) return false;
    for (const k of Object.keys(left)) left[k] -= n[k];
    return true;
  });
}

const validV2 = fc
  .record({
    style: fc.constantFrom(...STUDIO_STYLE_IDS),
    accent: fc.constantFrom(null, ...STUDIO_ACCENT_IDS),
    mode: fc.constantFrom('light', 'dark', 'auto'),
    coverPick: fc.nat({ max: 2 }),
    blocks: fc.array(blockV2, { maxLength: BLOCKS_V2 }),
    ids: fc.uniqueArray(id, { minLength: BLOCKS_V2, maxLength: BLOCKS_V2 }),
  })
  .map(({ ids, blocks, coverPick, ...doc }) => {
    const covers = STUDIO_STYLES[doc.style].covers;
    return {
      v: 2,
      ...doc,
      cover: covers[coverPick % covers.length],
      blocks: withinBudget(blocks.map((b, i) => ({ id: ids[i], ...b }))),
    };
  });

/** One rule broken per v2 document, each of which the strict schema must refuse. */
const BREAKS_V2 = [
  (d) => ({ ...d, css: 'color: red' }),
  (d) => ({ ...d, brand: ['#7a32f9'] }),
  (d) => ({ ...d, fonts: { heading: 'manrope', body: 'inter' } }),
  (d) => ({ ...d, rows: [] }),
  (d) => ({ ...d, scale: 'roomy' }),
  (d) => ({ ...d, corners: 'soft' }),
  (d) => ({ ...d, v: 1 }),
  (d) => ({ ...d, style: 'neon' }),
  (d) => ({ ...d, accent: 'magenta' }),
  (d) => ({ ...d, accent: undefined }),
  (d) => ({ ...d, mode: 'neon' }),
  (d) => ({ ...d, cover: 'video' }),
  (d) => ({ ...d, blocks: [{ id: 'aaaaaaaa', kind: 'about' }] }),
  (d) => ({ ...d, blocks: [{ id: 'aaaaaaaa', kind: 'links' }] }),
  (d) => ({
    ...d,
    blocks: [{ id: 'aaaaaaaa', kind: 'text', variant: 'lead', text: 'x' }],
  }),
  (d) => ({
    ...d,
    blocks: [
      { id: 'aaaaaaaa', kind: 'text', variant: 'heading', level: 2, text: 'x' },
    ],
  }),
  (d) => ({
    ...d,
    blocks: [{ id: 'aaaaaaaa', kind: 'quote', variant: 'plain', text: 'x' }],
  }),
  (d) => ({
    ...d,
    blocks: Array.from({ length: L.blocks + 1 }, (_, i) => ({
      id: `blk${String(i).padStart(5, '0')}`,
      kind: 'text',
      variant: 'paragraph',
      text: 'x',
    })),
  }),
  (d) => ({
    ...d,
    blocks: [
      { id: 'aaaaaaaa', kind: 'text', variant: 'paragraph', text: 'x' },
      { id: 'aaaaaaaa', kind: 'text', variant: 'paragraph', text: 'y' },
    ],
  }),
  (d) => ({
    ...d,
    style: 'sprint',
    cover: 'gradient',
  }),
];

/** Generates v2 documents (`valid: true`) or v2 documents that break exactly one rule. */
export function studioDocumentArb({ valid: wanted = true } = {}) {
  if (wanted) return validV2;
  return fc
    .tuple(validV2, fc.integer({ min: 0, max: BREAKS_V2.length - 1 }))
    .map(([d, i]) => BREAKS_V2[i](d));
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

/**
 * A random page made to pass the design check the way a person would: apply the first automatic
 * fix, and where only their input could help (a new photo, new words), remove that block or row.
 * Pages that pass straight away are mostly tiny; these keep most of what was generated.
 */
export function repairToPassing(doc, ctx) {
  let d = doc;
  for (let step = 0; step < 120; step += 1) {
    const { issues } = checkDesignV1(d, ctx);
    if (issues.length === 0) return d;
    const fixable = issues.find((i) =>
      i.fixes.some((f) => !STUDIO_FIX_NEEDS_INPUT.includes(f.id)),
    );
    let next;
    if (fixable) {
      const fix = fixable.fixes.find(
        (f) => !STUDIO_FIX_NEEDS_INPUT.includes(f.id),
      );
      next = applyStudioFixV1(d, fixable, fix.id);
    } else {
      const [issue] = issues;
      if (issue.at.block) next = applyStudioFixV1(d, issue, 'remove-block');
      else if (issue.rule === 'photo-resolution')
        next = applyStudioFixV1(d, issue, 'plain-background');
      else next = { ...d, rows: d.rows.filter((r) => r.id !== issue.at.row) };
    }
    if (JSON.stringify(next) === JSON.stringify(d))
      next = { ...d, rows: d.rows.slice(0, -1) };
    d = next;
  }
  return null;
}

/** A passing page and the facts it passes with, made by repairToPassing. */
export function studioPassingDocument() {
  return fc
    .tuple(studioDocumentV1Arb({ valid: true }), checkContext())
    .map(([doc, ctx]) => ({ doc: repairToPassing(doc, ctx), ctx }))
    .filter(({ doc }) => doc !== null);
}
