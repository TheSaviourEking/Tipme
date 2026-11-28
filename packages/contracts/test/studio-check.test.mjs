import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  DESIGN_CHECK_VERSION,
  STUDIO_ACCENTS,
  STUDIO_PRO_BLOCKS,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  applyStudioFix,
  checkDesign,
  defaultStudioDocument,
  proItemsOf,
  studioDocumentSchema,
  studioSlotWidth,
  STUDIO_HEADING_PX,
} from '../dist/index.js';
import { runs, seed } from './support/pbt.mjs';
import {
  IMAGE_POOL,
  VIDEO_POOL,
  studioDocumentArb,
} from './support/studio-arbitrary.mjs';

const BREAKPOINTS = [320, 390, 768, 1024, 1440];
const [IMG] = IMAGE_POOL;
const CTX = {
  images: { [IMG]: { width: 2400, height: 1800, bytes: 300_000 } },
  videos: {},
  profile: { name: 'Kemi Adeyemi', bio: true, links: 2 },
  plan: 'pro',
  coverKind: 'photo',
  hasAvatar: true,
};
const free = { ...CTX, plan: 'free' };
const doc = (extra = {}) => ({ ...defaultStudioDocument(), ...extra });
const photo = (id = 'photo001', extra = {}) => ({
  id,
  kind: 'photo',
  imageId: IMG,
  alt: 'A photo',
  ...extra,
});
const heading = (text, id = 'head0001') => ({
  id,
  kind: 'text',
  variant: 'heading',
  text,
});
const rules = (result) => result.issues.map((i) => i.rule);
const noticeRules = (result) => result.notices.map((n) => n.rule);

test('the check is version 3', () => {
  assert.equal(DESIGN_CHECK_VERSION, 3);
  assert.equal(checkDesign(doc(), CTX).version, 3);
});

test('pro-only fires on Free for a Pro style, the photo accent or a Pro block, and never on Pro', () => {
  const proStyle = doc({ style: 'stage' });
  const photoAccent = doc({ style: 'clear', accent: 'photo' });
  const proBlock = doc({ style: 'clear', blocks: [photo()] });
  for (const d of [proStyle, photoAccent, proBlock]) {
    assert.deepEqual(
      rules(checkDesign(d, free)),
      ['pro-only'],
      JSON.stringify(d),
    );
    assert.deepEqual(rules(checkDesign(d, CTX)), [], 'Pro never fires');
  }
  assert.equal(
    checkDesign(proBlock, free).issues[0].at.block,
    'photo001',
    'the issue points at the block',
  );
  for (const kind of STUDIO_PRO_BLOCKS)
    assert.ok(
      ['photo', 'gallery', 'video', 'services', 'events'].includes(kind),
    );
  // Text and quote are Free.
  const freeBlocks = doc({
    style: 'clear',
    blocks: [heading('Hello'), { id: 'quote001', kind: 'quote', text: 'Hi' }],
  });
  assert.deepEqual(rules(checkDesign(freeBlocks, free)), []);
  // Two Pro things are two issues, and a Pro block each.
  const many = doc({
    style: 'stage',
    accent: 'photo',
    blocks: [photo('photo001'), photo('photo002')],
  });
  assert.equal(
    rules(checkDesign(many, free)).filter((r) => r === 'pro-only').length,
    4,
  );
});

test('pro-only fixes: "Use Blue" sets the style default, "Remove the block" removes it, "Choose a free style" needs input, "See Pro" is a link', () => {
  const find = (result, id) =>
    result.issues.flatMap((i) => i.fixes).find((f) => f.id === id);

  const accentDoc = doc({ style: 'clear', accent: 'photo' });
  const accent = checkDesign(accentDoc, free);
  const useDefault = find(accent, 'use-default-accent');
  assert.equal(
    useDefault.label,
    `Use ${STUDIO_ACCENTS[STUDIO_STYLES.clear.defaultAccent].name}`,
  );
  assert.equal(useDefault.label, 'Use Blue');
  const fixedAccent = applyStudioFix(
    accentDoc,
    accent.issues[0],
    'use-default-accent',
  );
  assert.equal(fixedAccent.accent, null, 'null is the style default');
  assert.deepEqual(rules(checkDesign(fixedAccent, free)), []);
  assert.equal(accentDoc.accent, 'photo', 'the input is not changed');
  assert.ok(find(accent, 'see-pro'));
  assert.equal(find(accent, 'see-pro').label, 'See Pro');

  const blockDoc = doc({ style: 'clear', blocks: [heading('Hi'), photo()] });
  const block = checkDesign(blockDoc, free);
  assert.equal(find(block, 'remove-block').label, 'Remove the block');
  const removed = applyStudioFix(blockDoc, block.issues[0], 'remove-block');
  assert.deepEqual(
    removed.blocks.map((b) => b.id),
    ['head0001'],
  );
  assert.deepEqual(rules(checkDesign(removed, free)), []);

  const styleDoc = doc({ style: 'stage' });
  const style = checkDesign(styleDoc, free);
  assert.equal(find(style, 'choose-free-style').label, 'Choose a free style');
  assert.deepEqual(
    applyStudioFix(styleDoc, style.issues[0], 'choose-free-style'),
    styleDoc,
    'it needs the person to choose, so nothing changes',
  );
  assert.deepEqual(
    applyStudioFix(styleDoc, style.issues[0], 'see-pro'),
    styleDoc,
    'a link changes nothing',
  );
  assert.equal(find(style, 'use-default-accent'), undefined);
  // Classic's default accent is today's purple.
  const classic = checkDesign(doc({ style: 'classic', accent: 'photo' }), free);
  assert.equal(
    classic.issues[0].fixes.find((f) => f.id === 'use-default-accent').label,
    'Use TipMe purple',
  );
});

test('cover-photo is a notice for Stage and Horizon on Your cover without a photo', () => {
  const stage = checkDesign(doc({ style: 'stage' }), {
    ...CTX,
    coverKind: 'design',
  });
  assert.deepEqual(
    stage.notices.filter((n) => n.rule === 'cover-photo'),
    [
      {
        rule: 'cover-photo',
        message: 'Stage looks best with a cover photo. Add one in Settings.',
      },
    ],
  );
  assert.deepEqual(stage.issues, [], 'a notice, never an error');
  const horizon = checkDesign(doc({ style: 'horizon' }), {
    ...CTX,
    coverKind: 'none',
  });
  assert.equal(
    horizon.notices.find((n) => n.rule === 'cover-photo').message,
    'Horizon looks best with a cover photo. Add one in Settings.',
  );
  const quiet = (d, ctx) =>
    assert.ok(!noticeRules(checkDesign(d, ctx)).includes('cover-photo'));
  quiet(doc({ style: 'clear' }), { ...CTX, coverKind: 'none' });
  quiet(doc({ style: 'stage' }), { ...CTX, coverKind: 'photo' });
  quiet(doc({ style: 'stage', cover: 'gradient' }), {
    ...CTX,
    coverKind: 'none',
  });
  quiet(doc({ style: 'stage', cover: 'plain' }), { ...CTX, coverKind: 'none' });
});

test('name-fallback names the face', () => {
  const name = 'Ɗanlami Ƙwairanga Ɓello';
  const journal = checkDesign(doc({ style: 'journal' }), {
    ...CTX,
    profile: { ...CTX.profile, name },
  });
  assert.deepEqual(
    journal.notices.filter((n) => n.rule === 'name-fallback'),
    [
      {
        rule: 'name-fallback',
        message:
          "Your name has a letter Source Serif 4 can't draw, so it's set in Inter.",
      },
    ],
  );
  const clear = checkDesign(doc({ style: 'clear' }), {
    ...CTX,
    profile: { ...CTX.profile, name },
  });
  assert.ok(!noticeRules(clear).includes('name-fallback'), 'Clear is Inter');
  assert.ok(
    !noticeRules(checkDesign(doc({ style: 'journal' }), CTX)).includes(
      'name-fallback',
    ),
    'a name the face can draw',
  );
});

test('missing-links is a notice with no fix', () => {
  const none = checkDesign(doc(), {
    ...CTX,
    profile: { ...CTX.profile, links: 0 },
  });
  assert.deepEqual(none.notices, [
    {
      rule: 'missing-links',
      message: 'Add links in Settings to show them on your page.',
    },
  ]);
  assert.deepEqual(none.issues, []);
  assert.deepEqual(checkDesign(doc(), CTX).notices, []);
});

test("long-word measures headings in the style's display face at 320 px", () => {
  const word = (n) => 'W'.repeat(n);
  const signboard = doc({ style: 'signboard', blocks: [heading(word(40))] });
  const result = checkDesign(signboard, CTX);
  assert.deepEqual(rules(result), ['long-word']);
  assert.equal(result.issues[0].at.block, 'head0001');
  assert.deepEqual(
    result.issues[0].fixes.map((f) => [f.id, f.label]),
    [['shorter-heading', 'Use a shorter heading']],
  );
  // Needs input: nothing changes.
  assert.deepEqual(
    applyStudioFix(signboard, result.issues[0], 'shorter-heading'),
    signboard,
  );
  // Only headings are checked: a long word in a paragraph or a quote passes.
  const link = 'See https://example.com/a-very-long-link-to-something';
  const paragraph = {
    id: 'para0001',
    kind: 'text',
    variant: 'paragraph',
    text: link,
  };
  const quote = { id: 'quote001', kind: 'quote', text: link };
  for (const style of ['clear', 'signboard'])
    for (const block of [paragraph, quote])
      assert.deepEqual(
        rules(checkDesign(doc({ style, blocks: [block] }), CTX)),
        [],
        `${style} ${block.kind}`,
      );
  assert.deepEqual(
    rules(checkDesign(doc({ style: 'clear', blocks: [heading(link)] }), CTX)),
    ['long-word'],
  );
  // Unbounded is far wider than Inter: a word that fits Clear doesn't fit Signboard.
  const middle = 'Wwwwwwwwwwwwww';
  assert.deepEqual(
    rules(checkDesign(doc({ style: 'clear', blocks: [heading(middle)] }), CTX)),
    [],
  );
  assert.deepEqual(
    rules(
      checkDesign(doc({ style: 'signboard', blocks: [heading(middle)] }), CTX),
    ),
    ['long-word'],
  );
  assert.deepEqual(
    rules(
      checkDesign(
        doc({ style: 'clear', blocks: [heading('Hello there')] }),
        CTX,
      ),
    ),
    [],
  );
  // A name-like word the display face can't draw is set in Inter, so it is measured in Inter.
  const hausa = 'Ɗanlamiƙwairangaɓello'.slice(0, 14);
  assert.deepEqual(
    rules(
      checkDesign(doc({ style: 'journal', blocks: [heading(hausa)] }), CTX),
    ),
    [],
  );
});

test("Classic's section title is measured at the size classic.css draws", () => {
  // 2rem at every width (classic.css .studio-title).
  assert.equal(STUDIO_HEADING_PX.classic, 32);
  assert.equal(STUDIO_HEADING_PX.clear, 20);
  // Stage's phone section title is 22/28 (§9.4), Horizon's 18/24 (§9.9): apps/web test
  // studio-style-page holds both to stage.css and horizon.css.
  assert.equal(STUDIO_HEADING_PX.stage, 22);
  assert.equal(STUDIO_HEADING_PX.horizon, 18);
});

// PR 2e (§9.5, §9.6, §9.7): Signboard, Sprint and Tiles, as their CSS draws them (apps/web test
// studio-style-page holds each number to signboard.css, sprint.css and tiles.css).
test("Signboard's, Sprint's and Tiles' section titles are measured at the size their CSS draws", () => {
  // Signboard 15/22 Unbounded caps, Sprint 20/26 Inter, Tiles 15/20 Inter (the text tile title).
  assert.equal(STUDIO_HEADING_PX.signboard, 15);
  assert.equal(STUDIO_HEADING_PX.sprint, 20);
  assert.equal(STUDIO_HEADING_PX.tiles, 15);
});

test('Sprint measures headings in Inter: Anton sets the name only (§9.6)', () => {
  // Inter at 20 px, like Clear: 18 letters fit 280, 19 don't (Anton at 20 would pass 19, and at
  // the old 28 px fail 18).
  const sprint = (n) =>
    rules(
      checkDesign(
        doc({ style: 'sprint', blocks: [heading('W'.repeat(n))] }),
        CTX,
      ),
    );
  assert.deepEqual(sprint(18), []);
  assert.deepEqual(sprint(19), ['long-word']);
});

test("Signboard's titles are capitals: a heading word is measured at Unbounded's widest letter", () => {
  // 14 letters at 15 px: the mean of Unbounded's advances fits 280, its capitals don't.
  const word = 'Wwwwwwwwwwwwww';
  assert.deepEqual(
    rules(
      checkDesign(doc({ style: 'signboard', blocks: [heading(word)] }), CTX),
    ),
    ['long-word'],
  );
  assert.deepEqual(
    rules(
      checkDesign(
        doc({ style: 'signboard', blocks: [heading('Wwwwww')] }),
        CTX,
      ),
    ),
    [],
  );
});

test("Signboard's, Sprint's and Tiles' photo slots are the widths their CSS draws", () => {
  // Signboard (§9.5): photos 3-up, gap 8, in the column; on a desktop 440 | 80 | 600, every block
  // but the first in the 600 column.
  assert.equal(
    studioSlotWidth('signboard', 'gallery', 390),
    Math.round((350 - 16) / 3),
  );
  assert.equal(
    studioSlotWidth('signboard', 'gallery', 800),
    Math.round((720 - 16) / 3),
  );
  assert.equal(
    studioSlotWidth('signboard', 'gallery', 1440),
    Math.round((600 - 16) / 3),
  );
  for (const kind of ['text', 'quote', 'photo', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('signboard', kind, 1440), 600, kind);
  // Sprint (§9.6): photos run edge to edge at every width (a gallery's odd first photo takes the
  // whole row); everything else sits in the column, on a desktop the 680 cell of 680 | 120 | 480.
  for (const v of [320, 390, 800, 1024, 1440]) {
    assert.equal(studioSlotWidth('sprint', 'photo', v), v, `photo ${v}`);
    assert.equal(studioSlotWidth('sprint', 'gallery', v), v, `gallery ${v}`);
  }
  assert.equal(studioSlotWidth('sprint', 'text', 390), 350);
  for (const kind of ['text', 'quote', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('sprint', kind, 1440), 680, kind);
  // Tiles (§9.7): a 2-column grid, gap 12, below 1024; on a desktop a 340 rail, gap 72 (the
  // canvas), and a 788 px 4-column grid, gap 16. Photos, text and lists take the grid's width.
  // A gallery photo is one tile, but the last of a row closes it (fix round 1): on a phone an odd
  // last photo is 2 wide, on a desktop the last of 4n + 1 spans all four. The widest is the slot.
  assert.equal(studioSlotWidth('tiles', 'gallery', 390), 350);
  assert.equal(studioSlotWidth('tiles', 'gallery', 800), 720);
  assert.equal(studioSlotWidth('tiles', 'photo', 390), 350);
  assert.equal(studioSlotWidth('tiles', 'gallery', 1440), 788);
  for (const kind of ['text', 'quote', 'photo', 'video', 'services', 'events'])
    assert.equal(studioSlotWidth('tiles', kind, 1440), 788, kind);
});

test("Stage's and Horizon's photo slots are the widths their CSS draws", () => {
  // Stage (§9.4): a strip of 156 px tiles on a phone and tablet; on a desktop the 720 main column
  // with photos 3-up, gap 8 (the canvas's StageDesktop "Backstage" grid).
  for (const v of [320, 390, 768, 1023])
    assert.equal(studioSlotWidth('stage', 'gallery', v), 156, `${v}`);
  assert.equal(
    studioSlotWidth('stage', 'gallery', 1440),
    Math.round((720 - 16) / 3),
  );
  assert.equal(studioSlotWidth('stage', 'photo', 1440), 720);
  // Horizon (§9.9): 3-up at 3:4, gap 8 on a phone and tablet; on a desktop the 520 column, gap 16.
  assert.equal(
    studioSlotWidth('horizon', 'gallery', 390),
    Math.round((350 - 16) / 3),
  );
  assert.equal(
    studioSlotWidth('horizon', 'gallery', 320),
    Math.round((280 - 16) / 3),
  );
  assert.equal(
    studioSlotWidth('horizon', 'gallery', 800),
    Math.round((720 - 16) / 3),
  );
  assert.equal(
    studioSlotWidth('horizon', 'gallery', 1440),
    Math.round((520 - 32) / 3),
  );
  assert.equal(studioSlotWidth('horizon', 'photo', 1440), 520);
});

// Addendum ruling P3: Creator's desktop main column is 1040 − 420 − 80; its gallery is a strip of
// 156 px tiles at every width. Professional's blocks sit in one 640 column on desktop; its gallery
// is 3-up, gap 8.
test('Creator and Professional slot widths follow their layouts', () => {
  assert.equal(studioSlotWidth('creator', 'text', 1440), 540);
  assert.equal(studioSlotWidth('creator', 'photo', 1440), 540);
  assert.equal(studioSlotWidth('creator', 'gallery', 390), 156);
  assert.equal(studioSlotWidth('creator', 'gallery', 1440), 156);
  assert.equal(studioSlotWidth('professional', 'text', 1440), 640);
  assert.equal(studioSlotWidth('professional', 'gallery', 1440), 208);
  assert.equal(studioSlotWidth('professional', 'gallery', 390), 111);
  assert.equal(studioSlotWidth('professional', 'photo', 390), 350);
});

test('heading sizes: Creator 20, Professional 18', () => {
  assert.equal(STUDIO_HEADING_PX.creator, 20);
  assert.equal(STUDIO_HEADING_PX.professional, 18);
});

test('cover-photo fires for Creator on Your cover without a photo, never for Professional', () => {
  for (const coverKind of ['design', 'none'])
    assert.deepEqual(
      checkDesign(doc({ style: 'creator' }), { ...CTX, coverKind }).notices,
      [
        {
          rule: 'cover-photo',
          message:
            'Creator looks best with a cover photo. Add one in Settings.',
        },
      ],
      coverKind,
    );
  assert.ok(
    !noticeRules(
      checkDesign(doc({ style: 'creator' }), { ...CTX, coverKind: 'photo' }),
    ).includes('cover-photo'),
  );
  for (const coverKind of ['photo', 'design', 'none'])
    assert.ok(
      !noticeRules(
        checkDesign(doc({ style: 'professional' }), { ...CTX, coverKind }),
      ).includes('cover-photo'),
      coverKind,
    );
});

test('name-fallback never fires for Creator or Professional', () => {
  const name = 'Ɗanlami Ƙwairanga Ɓello';
  for (const style of ['creator', 'professional'])
    assert.ok(
      !noticeRules(
        checkDesign(doc({ style }), {
          ...CTX,
          profile: { ...CTX.profile, name },
        }),
      ).includes('name-fallback'),
      style,
    );
});

test("photo rules use the style's slot widths", () => {
  const widest = (style) =>
    Math.max(...[390, 1440].map((v) => studioSlotWidth(style, 'photo', v)));
  const at = (style, width) =>
    checkDesign(doc({ style, blocks: [photo()] }), {
      ...CTX,
      images: { [IMG]: { width, height: width, bytes: 200_000 } },
    });
  // Clear: a 440 px column on desktop, 350 px on a phone.
  assert.equal(studioSlotWidth('clear', 'photo', 1440), (920 - 40) / 2);
  assert.equal(studioSlotWidth('clear', 'photo', 390), 390 - 40);
  // Clear's photos as its CSS draws them (§9.2): a 150 px strip up to 1023 px, then a 3-up
  // square grid in the 440 column, gap 8 (apps/web test studio-style-page holds the CSS to it).
  for (const v of [320, 390, 768, 1023])
    assert.equal(studioSlotWidth('clear', 'gallery', v), 150, `${v}`);
  assert.equal(studioSlotWidth('clear', 'gallery', 1024), 141);
  assert.equal(studioSlotWidth('clear', 'gallery', 1440), 141);
  // Classic as classic.css draws it on today's page (§9.1; apps/web test studio-classic holds
  // the CSS to it). Two columns from 861 px: min(1120, vw − 80) − 408 rail − clamp(32, 5vw, 72)
  // gap − 40 inset, widest at 1200 (612), 600 at 1440; one column below: min(vw, 576) − 32.
  // A gallery photo is 2-up with an 8 px gap.
  const classic = (kind, v) => studioSlotWidth('classic', kind, v);
  for (const [v, w] of [
    [1440, 600],
    [1200, 612],
    [1024, 445],
    [861, 290],
    [860, 544],
    [768, 544],
    [576, 544],
    [390, 358],
    [320, 288],
  ]) {
    for (const kind of [
      'text',
      'quote',
      'photo',
      'video',
      'services',
      'events',
    ])
      assert.equal(classic(kind, v), w, `${kind} at ${v}`);
  }
  assert.equal(classic('gallery', 1440), 296);
  assert.equal(classic('gallery', 1200), 302);
  assert.equal(classic('gallery', 390), 175);
  // photo-resolution asks for the drawn width at 1440.
  assert.deepEqual(rules(at('classic', 599)), ['photo-resolution']);
  assert.deepEqual(rules(at('classic', 600)), []);
  // As in v1: 1x at the widest screen, no density factor and no cap.
  assert.equal(widest('clear'), 440);
  assert.equal(widest('stage'), 720);
  assert.deepEqual(rules(at('clear', 439)), ['photo-resolution']);
  assert.deepEqual(rules(at('clear', 440)), []);
  // Passes now, failed under the 2x rule (880).
  assert.deepEqual(rules(at('clear', 640)), []);
  // Another style, another slot: Stage's main column is wider, so it needs more.
  assert.deepEqual(rules(at('stage', 640)), ['photo-resolution']);
  assert.deepEqual(rules(at('stage', 719)), ['photo-resolution']);
  assert.deepEqual(rules(at('stage', 720)), []);
  // Sprint's full-bleed photos need the full 1440.
  assert.deepEqual(rules(at('sprint', 1439)), ['photo-resolution']);
  assert.deepEqual(rules(at('sprint', 1440)), []);
  // A photo we have no facts for is as blurry as one with no pixels.
  assert.deepEqual(
    rules(checkDesign(doc({ blocks: [photo()] }), { ...CTX, images: {} })),
    ['photo-resolution'],
  );
  // The fix needs a new photo.
  const blurry = at('clear', 400);
  assert.deepEqual(
    blurry.issues[0].fixes.map((f) => f.id),
    ['replace-photo'],
  );
  // The slot is never a column the person chose: it only depends on style, kind and screen.
  for (const style of STUDIO_STYLE_IDS)
    for (const v of BREAKPOINTS)
      for (const kind of ['text', 'photo', 'gallery', 'video'])
        assert.ok(
          studioSlotWidth(style, kind, v) > 0 &&
            studioSlotWidth(style, kind, v) <= Math.max(v, 1440),
          `${style} ${kind} ${v}`,
        );
});

test('photo-alt, empty-block, broken-video and page-weight keep their fixes', () => {
  const noAlt = doc({ blocks: [photo('photo001', { alt: '' })] });
  const alt = checkDesign(noAlt, CTX);
  assert.deepEqual(rules(alt), ['photo-alt']);
  assert.deepEqual(
    alt.issues[0].fixes.map((f) => f.id),
    ['mark-decorative', 'add-description'],
  );
  const marked = applyStudioFix(noAlt, alt.issues[0], 'mark-decorative');
  assert.equal(marked.blocks[0].decorative, true);
  assert.deepEqual(rules(checkDesign(marked, CTX)), []);

  const emptyGallery = doc({
    blocks: [{ id: 'gal00001', kind: 'gallery', images: [] }],
  });
  const empty = checkDesign(emptyGallery, CTX);
  assert.deepEqual(rules(empty), ['empty-block']);
  assert.deepEqual(
    empty.issues[0].fixes.map((f) => f.label),
    ['Remove the block'],
  );
  const emptyText = checkDesign(doc({ blocks: [heading('')] }), CTX);
  assert.deepEqual(rules(emptyText), ['empty-block']);

  const [url] = VIDEO_POOL;
  const gone = doc({ blocks: [{ id: 'vid00001', kind: 'video', url }] });
  const broken = checkDesign(gone, { ...CTX, videos: { [url]: 'gone' } });
  assert.deepEqual(rules(broken), ['broken-video']);
  assert.deepEqual(
    broken.issues[0].fixes.map((f) => f.id),
    ['remove-video', 'change-link'],
  );
  assert.deepEqual(
    rules(checkDesign(gone, { ...CTX, videos: { [url]: 'unknown' } })),
    [],
  );
  assert.deepEqual(
    applyStudioFix(gone, broken.issues[0], 'remove-video').blocks,
    [],
  );

  // Page weight: many big photos near the top of a phone page.
  const heavy = doc({
    blocks: IMAGE_POOL.slice(0, 6).map((imageId, i) =>
      photo(`heavy00${i}`, { imageId }),
    ),
  });
  const ctx = {
    ...CTX,
    images: Object.fromEntries(
      IMAGE_POOL.slice(0, 6).map((id) => [
        id,
        { width: 1500, height: 1500, bytes: 3_000_000 },
      ]),
    ),
  };
  const weight = checkDesign(heavy, ctx);
  assert.ok(rules(weight).includes('page-weight'));
  assert.ok(weight.weightBytes > 1_500_000);
  assert.ok(
    !rules(checkDesign(doc(), CTX)).includes('page-weight'),
    'a light page',
  );
});

test('the removed rules never fire', () => {
  const removed = [
    'contrast',
    'contrast-on-photo',
    'fonts',
    'phone-fit',
    'crowded',
    'heading-order',
  ];
  const check = (d, plan, ctx) => {
    const result = checkDesign(d, { ...ctx, plan });
    for (const r of [
      ...rules(result),
      ...noticeRules(result),
      ...result.passing,
    ])
      assert.ok(!removed.includes(r), r);
  };
  fc.assert(
    fc.property(
      studioDocumentArb({ valid: true }),
      fc.constantFrom('free', 'pro'),
      contextArb(),
      (d, plan, ctx) => check(d, plan, ctx),
    ),
    { numRuns: runs(500), seed: seed() },
  );
});

test('the default document passes on Free and Pro', () => {
  for (const plan of ['free', 'pro']) {
    const result = checkDesign(defaultStudioDocument(), { ...CTX, plan });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.notices, []);
    assert.equal(result.passing.length, 7);
  }
});

test('proItemsOf lists what needs Pro', () => {
  assert.deepEqual(proItemsOf(defaultStudioDocument()), {
    style: false,
    photoAccent: false,
    blockIds: [],
  });
  assert.deepEqual(
    proItemsOf(
      doc({
        style: 'tiles',
        accent: 'photo',
        blocks: [heading('Hi'), photo('photo001'), photo('photo002')],
      }),
    ),
    { style: true, photoAccent: true, blockIds: ['photo001', 'photo002'] },
  );
});

function contextArb() {
  const facts = fc.record({
    width: fc.integer({ min: 100, max: 4000 }),
    height: fc.integer({ min: 100, max: 4000 }),
    bytes: fc.integer({ min: 10_000, max: 3_000_000 }),
  });
  return fc
    .record({
      images: fc.array(facts, {
        minLength: IMAGE_POOL.length,
        maxLength: IMAGE_POOL.length,
      }),
      videos: fc.array(fc.constantFrom('ok', 'gone', 'unknown'), {
        minLength: VIDEO_POOL.length,
        maxLength: VIDEO_POOL.length,
      }),
      name: fc.constantFrom(
        'Kemi Adeyemi',
        'Ɗanlami Ƙwairanga Ɓello',
        'Ọlápéjú Adébáyọ̀',
        'A',
      ),
      bio: fc.boolean(),
      links: fc.integer({ min: 0, max: 8 }),
      coverKind: fc.constantFrom(
        'photo',
        'design',
        'automatic',
        'animated',
        'none',
      ),
      hasAvatar: fc.boolean(),
    })
    .map((c) => ({
      images: Object.fromEntries(IMAGE_POOL.map((id, i) => [id, c.images[i]])),
      videos: Object.fromEntries(VIDEO_POOL.map((u, i) => [u, c.videos[i]])),
      profile: { name: c.name, bio: c.bio, links: c.links },
      plan: 'free',
      coverKind: c.coverKind,
      hasAvatar: c.hasAvatar,
    }));
}

const key = (i) =>
  `${i.rule}|${i.at.row}|${i.at.block ?? ''}|${i.at.cell ?? ''}`;
const PAGE = ['page-weight'];
const sameKey = (a, b) =>
  a.rule === b.rule && (PAGE.includes(a.rule) || key(a) === key(b));

test('every offered pure fix removes its issue and adds no new error', () => {
  const pure = new Set([
    'use-default-accent',
    'remove-block',
    'remove-video',
    'mark-decorative',
    'move-lower',
  ]);
  let offered = 0;
  fc.assert(
    fc.property(
      studioDocumentArb({ valid: true }),
      fc.constantFrom('free', 'pro'),
      contextArb(),
      (d, plan, base) => {
        const ctx = { ...base, plan };
        const before = checkDesign(d, ctx);
        for (const issue of before.issues)
          for (const fix of issue.fixes) {
            if (!pure.has(fix.id)) continue;
            offered += 1;
            const next = applyStudioFix(d, issue, fix.id);
            assert.notDeepEqual(next, d, `${fix.id} changed nothing`);
            assert.equal(studioDocumentSchema.safeParse(next).success, true);
            const after = checkDesign(next, ctx);
            assert.ok(
              !after.issues.some((a) => sameKey(a, issue)),
              `${fix.id} left its issue`,
            );
            for (const a of after.issues)
              assert.ok(
                before.issues.some((b) => sameKey(a, b)),
                `${fix.id} added ${key(a)}`,
              );
          }
      },
    ),
    { numRuns: runs(500), seed: seed() },
  );
  assert.ok(offered > 0, 'the property saw fixes');
});

test('checkDesign is pure and deterministic', () => {
  fc.assert(
    fc.property(
      studioDocumentArb({ valid: true }),
      fc.constantFrom('free', 'pro'),
      contextArb(),
      (d, plan, base) => {
        const ctx = { ...base, plan };
        const frozenDoc = JSON.stringify(d);
        const frozenCtx = JSON.stringify(ctx);
        const first = checkDesign(d, ctx);
        assert.deepEqual(
          checkDesign(JSON.parse(JSON.stringify(d)), ctx),
          first,
        );
        assert.equal(
          JSON.stringify(d),
          frozenDoc,
          'the document is not changed',
        );
        assert.equal(
          JSON.stringify(ctx),
          frozenCtx,
          'the facts are not changed',
        );
        for (const issue of first.issues)
          for (const fix of issue.fixes)
            assert.deepEqual(
              applyStudioFix(d, issue, fix.id),
              applyStudioFix(d, issue, fix.id),
            );
        assert.equal(
          JSON.stringify(d),
          frozenDoc,
          'fixes do not change their input',
        );
      },
    ),
    { numRuns: runs(500), seed: seed() },
  );
});
