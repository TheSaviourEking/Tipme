import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  BLOCK_MIN_WIDTH,
  DESIGN_CHECK_VERSION,
  STUDIO_BREAKPOINTS,
  STUDIO_FIX_NEEDS_INPUT,
  STUDIO_FONTS,
  applyStudioFix,
  blocksIn,
  cellWidths,
  checkDesign,
  defaultStudioDocument,
  sameIssue,
  studioColourName,
  studioDocumentSchema,
  studioIssueKeys,
  studioLargeText,
} from '../dist/index.js';
import {
  EXAMPLE_CONTEXT,
  IFY,
  KEMI,
  SULE,
} from './fixtures/studio-examples.mjs';
import { regressions, runs, seed } from './support/pbt.mjs';
import {
  IMAGE_POOL,
  checkContext,
  imageFacts,
  studioDocument,
} from './support/studio-arbitrary.mjs';

const CTX = EXAMPLE_CONTEXT;
const [IMG] = IMAGE_POOL;
const base = { ...KEMI, rows: [] };
const page = (...rows) => ({ ...base, rows });
const row = (id, cells, extra = {}) => ({
  id,
  columns: ['1', '1-1', '1-1-1'][cells.length - 1],
  spacing: 'm',
  background: 'page',
  cells,
  ...extra,
});
const h2 = (id, text = 'Hello') => ({
  id,
  kind: 'text',
  variant: 'heading',
  level: 2,
  text,
});
const photo = (id, extra = {}) => ({
  id,
  kind: 'photo',
  variant: 'square',
  imageId: IMG,
  alt: 'A photo',
  ...extra,
});
const withImage = (facts) => ({
  ...CTX,
  images: { ...CTX.images, [IMG]: facts },
});
const rulesOf = (d, ctx = CTX) => checkDesign(d, ctx).issues.map((i) => i.rule);
const fixIds = (issue) => issue.fixes.map((f) => f.id);
const automatic = (issue) =>
  issue.fixes.filter((f) => !STUDIO_FIX_NEEDS_INPUT.includes(f.id));

test('the curated examples pass, with their notices', () => {
  for (const [name, doc] of Object.entries({ KEMI, SULE, IFY })) {
    assert.equal(studioDocumentSchema.safeParse(doc).success, true, name);
    const result = checkDesign(doc, CTX);
    assert.deepEqual(
      result.issues,
      [],
      `${name}: ${JSON.stringify(result.issues)}`,
    );
    assert.equal(result.version, DESIGN_CHECK_VERSION);
    assert.ok(
      result.weightBytes > 0 && result.weightBytes < 1_500_000,
      `${name} ${result.weightBytes}`,
    );
  }
  const sule = checkDesign(SULE, CTX).notices.map((n) => n.message);
  assert.ok(
    sule.includes(
      'Your yellow is too light for text on a light page. We’ll use it for highlights and for buttons with dark text, and a deeper shade of it for links and headings. Your page will still look yellow.',
    ),
    sule.join('\n'),
  );
  assert.ok(sule.some((m) => /shade behind the words on the photo/.test(m)));
  assert.ok(
    checkDesign(IFY, CTX).notices.some(
      (n) =>
        n.rule === 'contrast' &&
        /pink is too light for small text/.test(n.message),
    ),
  );
});

test('each rule fires on its minimal bad example', () => {
  // phone-fit: service cards need 220 px; a third of the row is about 185 px on a 1024 px screen.
  const cards = {
    id: 'blk00002',
    kind: 'services',
    variant: 'cards',
    items: [{ name: 'Cut', priceMinor: '500000' }],
  };
  assert.deepEqual(
    rulesOf(page(row('row00001', [[h2('blk00001')], [cards], []]))),
    ['phone-fit'],
  );
  // long-word
  assert.deepEqual(
    rulesOf(page(row('row00001', [[h2('blk00001', 'W'.repeat(40))]]))),
    ['long-word'],
  );
  // heading-order
  assert.deepEqual(
    rulesOf(
      page(
        row('row00001', [[{ ...h2('blk00001'), level: 3 }, h2('blk00002')]]),
      ),
    ),
    ['heading-order'],
  );
  // crowded: three photos in a third of a row
  const narrow = {
    ...row('row00001', [
      [h2('blk00001')],
      [photo('blk00002'), photo('blk00003'), photo('blk00004')],
    ]),
    columns: '2-1',
  };
  assert.deepEqual(rulesOf(page(narrow)), ['crowded']);
  // crowded: two colour rows touching with small spacing
  assert.deepEqual(
    rulesOf(
      page(
        row('row00001', [[h2('blk00001')]], {
          background: 'colour',
          spacing: 's',
        }),
        row('row00002', [[h2('blk00002')]], { background: 'colour' }),
      ),
    ),
    ['crowded'],
  );
  // photo-resolution, photo-alt
  assert.deepEqual(
    rulesOf(
      page(row('row00001', [[h2('blk00001'), photo('blk00002')]])),
      withImage(imageFacts({ width: 500, height: 500 })),
    ),
    ['photo-resolution'],
  );
  assert.deepEqual(
    rulesOf(
      page(row('row00001', [[h2('blk00001'), photo('blk00002', { alt: '' })]])),
    ),
    ['photo-alt'],
  );
  assert.deepEqual(
    rulesOf(
      page(
        row('row00001', [
          [h2('blk00001'), photo('blk00002', { alt: '', decorative: true })],
        ]),
      ),
    ),
    [],
  );
  // page-weight: a heavy photo at the top
  const heavy = withImage(
    imageFacts({ width: 2400, height: 2400, perPixel: 2 }),
  );
  assert.deepEqual(
    rulesOf(page(row('row00001', [[photo('blk00001')]])), heavy),
    ['page-weight'],
  );
  // empty-block
  assert.deepEqual(
    rulesOf(
      page(
        row('row00001', [
          [
            h2('blk00001'),
            { id: 'blk00002', kind: 'gallery', variant: 'grid', images: [] },
          ],
        ]),
      ),
    ),
    ['empty-block'],
  );
  assert.deepEqual(
    rulesOf(
      page(
        row('row00001', [
          [{ id: 'blk00001', kind: 'about', variant: 'plain' }],
        ]),
      ),
      { ...CTX, profile: { bio: false, links: 0 } },
    ),
    ['empty-block'],
  );
  // broken-video
  const video = {
    id: 'blk00002',
    kind: 'video',
    variant: 'still',
    url: 'https://youtu.be/dQw4w9WgXcQ',
  };
  const d = page(row('row00001', [[h2('blk00001'), video]]));
  assert.deepEqual(
    rulesOf(d, { ...CTX, videos: { 'https://youtu.be/dQw4w9WgXcQ': 'gone' } }),
    ['broken-video'],
  );
  assert.deepEqual(
    rulesOf(d, {
      ...CTX,
      videos: { 'https://youtu.be/dQw4w9WgXcQ': 'unknown' },
    }),
    [],
    'unknown never fails',
  );
});

test('rules that the schema or engine already guarantee stay silent, and say what they fixed', () => {
  const r = checkDesign(page(row('row00001', [[h2('blk00001', 'Ṣọlá')]])), CTX);
  assert.deepEqual(r.issues, []);
  // Kemi's heading font is Fraunces, which has no Ṅ; Ṣọlá it draws. Manrope has no Ṣ.
  const manrope = checkDesign(
    {
      ...page(row('row00001', [[h2('blk00001', 'Ṣọlá')]])),
      fonts: { heading: 'manrope', body: 'inter' },
    },
    CTX,
  );
  assert.ok(
    manrope.notices.some(
      (n) => n.rule === 'fonts' && /Set in your text font/.test(n.message),
    ),
  );
  for (const rule of ['contrast', 'fonts'])
    assert.ok(r.passing.includes(rule), rule);
});

test('a photo 640 wide in a 2-1 wide cell fails; the same photo in a 1-1 cell passes', () => {
  const ctx = withImage(imageFacts({ width: 640, height: 640 }));
  const two = {
    ...row('row00001', [[h2('blk00001'), photo('blk00002')], [h2('blk00003')]]),
    columns: '2-1',
  };
  const [issue] = checkDesign(page(two), ctx).issues;
  assert.equal(issue?.rule, 'photo-resolution');
  assert.deepEqual(fixIds(issue), ['smaller-slot', 'replace-photo']);
  assert.equal(issue.fixes[0].label, 'Make the photo smaller');
  assert.match(issue.detail, /640 pixels wide, shown at up to 672/);
  const fixed = applyStudioFix(page(two), issue, 'smaller-slot');
  assert.equal(fixed.rows[0].columns, '1-1');
  assert.deepEqual(checkDesign(fixed, ctx).issues, []);
  assert.deepEqual(
    checkDesign(page({ ...two, columns: '1-1' }), ctx).issues,
    [],
  );
});

test('the weight estimate counts only photos in the first 1.5 screens and only the fonts used', () => {
  const filler = (i) =>
    row(`row0000${i}`, [
      [
        {
          id: `blk0000${i}`,
          kind: 'text',
          variant: 'paragraph',
          text: 'Words. '.repeat(80).trim(),
        },
      ],
    ]);
  const top = page(row('row00001', [[photo('blk00001')]]));
  const low = page(
    filler(2),
    filler(3),
    filler(4),
    row('row00001', [[photo('blk00001')]]),
  );
  const noPhoto = page(filler(2), filler(3), filler(4));
  const w = (d) => checkDesign(d, CTX).weightBytes;
  assert.ok(w(top) > w(page()), 'a photo at the top counts');
  assert.equal(w(low), w(noPhoto), 'a photo lower down loads lazily');
  const font = (id) => STUDIO_FONTS.find((f) => f.id === id).files[0].bytes;
  const one = { ...page(), fonts: { heading: 'nunito', body: 'nunito' } };
  const two = { ...page(), fonts: { heading: 'fraunces', body: 'nunito' } };
  assert.equal(w(two) - w(one), font('fraunces'));
});

test('large text: DM Serif Display h3 is not large; bold h3 at 18.66px or more is', () => {
  const dm = { ...base, fonts: { heading: 'dm-serif-display', body: 'inter' } };
  assert.equal(studioLargeText(dm, 'h3'), false);
  assert.equal(studioLargeText(dm, 'display'), true);
  assert.equal(
    studioLargeText(
      { ...base, scale: 'compact', fonts: { heading: 'inter', body: 'inter' } },
      'h3',
    ),
    true,
  );
  assert.equal(
    studioLargeText(
      { ...base, fonts: { heading: 'fraunces', body: 'inter' } },
      'h3',
    ),
    false,
  ); // 600 weight, 20px
});

test('colour names for the one-sentence notes', () => {
  assert.equal(studioColourName('#f5c400'), 'yellow');
  assert.equal(studioColourName('#1d4e89'), 'blue');
  assert.equal(studioColourName('#e0457b'), 'pink');
  assert.equal(studioColourName('#777777'), 'grey');
  assert.equal(studioColourName('#7a32f9'), 'purple');
  assert.equal(studioColourName('#2e7d32'), 'green');
  assert.equal(studioColourName('#d32f2f'), 'red');
  assert.equal(studioColourName('#6d4c41'), 'brown');
});

test('studioIssueKeys lists the same issues as checkDesign', () => {
  fc.assert(
    fc.property(studioDocument({ valid: true }), checkContext(), (doc, ctx) => {
      assert.deepEqual(
        studioIssueKeys(doc, ctx),
        checkDesign(doc, ctx).issues.map(({ rule, at }) => ({ rule, at })),
      );
    }),
    { numRuns: runs(500), seed: seed() },
  );
});

test('checkDesign is pure and deterministic', () => {
  fc.assert(
    fc.property(studioDocument({ valid: true }), checkContext(), (doc, ctx) => {
      const before = structuredClone(doc);
      const a = checkDesign(doc, ctx);
      assert.deepEqual(doc, before);
      assert.deepEqual(
        checkDesign(structuredClone(doc), structuredClone(ctx)),
        a,
      );
    }),
    { numRuns: runs(500), seed: seed() },
  );
});

test('every offered fix removes its issue and adds no new error', () => {
  const property = (doc, ctx) => {
    const before = checkDesign(doc, ctx);
    for (const issue of before.issues)
      for (const f of automatic(issue)) {
        const next = applyStudioFix(doc, issue, f.id);
        assert.equal(
          studioDocumentSchema.safeParse(next).success,
          true,
          `${issue.rule}/${f.id}`,
        );
        const after = studioIssueKeys(next, ctx);
        assert.ok(
          !after.some((i) => sameIssue(i, issue)),
          `${issue.rule}/${f.id} left its issue`,
        );
        assert.ok(
          after.every((i) => before.issues.some((b) => sameIssue(b, i))),
          `${issue.rule}/${f.id} added an issue`,
        );
      }
  };
  for (const [doc, ctx] of regressions('fixes')) property(doc, ctx);
  fc.assert(
    fc.property(studioDocument({ valid: true }), checkContext(), property),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('repeatedly applying the first automatic fix reaches a passing page or only input-needing issues', () => {
  fc.assert(
    fc.property(studioDocument({ valid: true }), checkContext(), (doc, ctx) => {
      let d = doc;
      let result = checkDesign(d, ctx);
      const start = result.issues.length;
      for (let step = 0; step <= start; step += 1) {
        const issue = result.issues.find((i) => automatic(i).length > 0);
        if (!issue) break;
        d = applyStudioFix(d, issue, automatic(issue)[0].id);
        const next = checkDesign(d, ctx);
        assert.ok(
          next.issues.length < result.issues.length,
          'each fix leaves fewer issues',
        );
        result = next;
      }
      assert.ok(result.issues.every((i) => automatic(i).length === 0));
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('a passing document fits every breakpoint in the layout model', () => {
  fc.assert(
    fc.property(studioDocument({ valid: true }), checkContext(), (doc, ctx) => {
      if (checkDesign(doc, ctx).issues.length) return;
      for (const w of STUDIO_BREAKPOINTS)
        for (const [cell, width] of Object.entries(cellWidths(doc, w)))
          for (const b of blocksIn(doc, cell))
            assert.ok(
              BLOCK_MIN_WIDTH[`${b.kind}:${b.variant}`] <= width,
              `${b.kind}:${b.variant} in ${width}px at ${w}`,
            );
    }),
    { numRuns: runs(2000), seed: seed() },
  );
});

test('every block fits a single column on the narrowest phone, even on a coloured row', () => {
  const narrowest = Math.min(
    ...Object.values(
      cellWidths(page(row('row00001', [[]], { background: 'colour' })), 320),
    ),
  );
  for (const [kind, min] of Object.entries(BLOCK_MIN_WIDTH))
    assert.ok(min <= narrowest, `${kind} ${min} > ${narrowest}`);
});

test('defaultStudioDocument passes the design check', () => {
  for (const profile of [
    { bio: 'Singer, Lagos', links: 3 },
    { bio: null, links: 0 },
    { bio: '', links: 2 },
  ]) {
    const ctx = {
      images: {},
      videos: {},
      profile: { bio: Boolean(profile.bio), links: profile.links },
    };
    assert.deepEqual(
      checkDesign(defaultStudioDocument(profile), ctx).issues,
      [],
      JSON.stringify(profile),
    );
  }
});
