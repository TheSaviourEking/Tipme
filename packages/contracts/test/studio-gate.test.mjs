import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  STUDIO_PRO_BLOCKS,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  isClassicDefault,
  proItemsOf,
  studioDraftRefusal,
  studioDraftSchema,
  studioShown,
} from '../dist/index.js';
import { runs, seed } from './support/pbt.mjs';
import { studioDocumentArb } from './support/studio-arbitrary.mjs';
import { KEMI } from './fixtures/studio-examples.mjs';

// What a page shows for its plan, and what a Free save may hold (styles spec §11, §12.5; plan
// ruling R4, Review Focus 1 and 4).

const IMG1 = '00000000-0000-4000-8000-000000000001';
const IMG2 = '00000000-0000-4000-8000-000000000002';
const IMG3 = '00000000-0000-4000-8000-000000000003';

const heading = (id, text = 'New single') => ({
  id,
  kind: 'text',
  variant: 'heading',
  text,
});
const paragraph = (id, text = 'Every tip goes into studio time.') => ({
  id,
  kind: 'text',
  variant: 'paragraph',
  text,
});
const quote = (id, text = 'Sang like home.') => ({ id, kind: 'quote', text });
const gallery = (id, ids = [IMG1, IMG2], alt = 'On stage') => ({
  id,
  kind: 'gallery',
  images: ids.map((imageId) => ({ imageId, alt })),
});
const video = (id) => ({
  id,
  kind: 'video',
  url: 'https://youtu.be/dQw4w9WgXcQ',
});
const doc = (extra = {}) => ({
  v: 2,
  style: 'clear',
  accent: null,
  mode: 'light',
  cover: 'yours',
  blocks: [],
  ...extra,
});

test('a Pro page shows its design; Classic defaults show the standard page', () => {
  const stage = doc({
    style: 'stage',
    accent: 'photo',
    mode: 'dark',
    blocks: [heading('blk00001'), gallery('blk00002')],
  });
  assert.deepEqual(studioShown(stage, 'pro'), stage);
  assert.equal(studioShown(doc({ style: 'classic' }), 'pro'), null);
  assert.equal(studioShown(doc({ style: 'classic' }), 'free'), null);
  // Any one choice on Classic is a design.
  for (const choice of [
    { accent: 'blue' },
    { mode: 'dark' },
    { mode: 'auto' },
    { cover: 'plain' },
    { blocks: [heading('blk00001')] },
  ]) {
    const classic = doc({ style: 'classic', ...choice });
    assert.deepEqual(
      studioShown(classic, 'pro'),
      classic,
      JSON.stringify(choice),
    );
    assert.deepEqual(
      studioShown(classic, 'free'),
      classic,
      JSON.stringify(choice),
    );
  }
});

test('a lapsed Pro style shows Classic with their accent, mode, cover and text and quote blocks', () => {
  const blocks = [
    heading('blk00001'),
    gallery('blk00002'),
    quote('blk00003'),
    video('blk00004'),
    paragraph('blk00005'),
  ];
  assert.deepEqual(
    studioShown(
      doc({
        style: 'stage',
        accent: 'coral',
        mode: 'auto',
        cover: 'gradient',
        blocks,
      }),
      'free',
    ),
    doc({
      style: 'classic',
      accent: 'coral',
      mode: 'auto',
      cover: 'gradient',
      blocks: [heading('blk00001'), quote('blk00003'), paragraph('blk00005')],
    }),
  );
  // The photo accent becomes Classic's purple; Signboard's plain cover stays plain.
  assert.deepEqual(
    studioShown(
      doc({
        style: 'signboard',
        accent: 'photo',
        mode: 'dark',
        cover: 'plain',
      }),
      'free',
    ),
    doc({ style: 'classic', accent: null, mode: 'dark', cover: 'plain' }),
  );
  // Nothing left but Classic's defaults: the standard page.
  assert.equal(
    studioShown(
      doc({ style: 'horizon', accent: 'photo', blocks: [gallery('blk00002')] }),
      'free',
    ),
    null,
  );
  // Every Pro style, every cover it offers, lands on a cover Classic offers.
  for (const style of STUDIO_STYLE_IDS.filter(
    (s) => STUDIO_STYLES[s].plan === 'pro',
  ))
    for (const cover of STUDIO_STYLES[style].covers) {
      const shown = studioShown(doc({ style, cover, mode: 'dark' }), 'free');
      assert.equal(shown.style, 'classic');
      assert.ok(STUDIO_STYLES.classic.covers.includes(shown.cover));
    }
});

test('a lapsed free style keeps its style and drops the photo accent and Pro blocks', () => {
  const blocks = [heading('blk00001'), gallery('blk00002'), quote('blk00003')];
  assert.deepEqual(
    studioShown(
      doc({ style: 'journal', accent: 'photo', mode: 'dark', blocks }),
      'free',
    ),
    doc({
      style: 'journal',
      accent: null,
      mode: 'dark',
      blocks: [heading('blk00001'), quote('blk00003')],
    }),
  );
  const linen = doc({ style: 'linen', accent: 'green', cover: 'plain' });
  assert.equal(
    studioShown(linen, 'free'),
    linen,
    'nothing hidden: the same document',
  );
  // A Classic page whose only choices were Pro ones is the standard page.
  assert.equal(
    studioShown(
      doc({ style: 'classic', accent: 'photo', blocks: [video('blk00004')] }),
      'free',
    ),
    null,
  );
});

test('Free shows only text and quote blocks: a kind outside that list never leaks', () => {
  // The supporter wall is not Pro-listed (STUDIO_PRO_BLOCKS) and is refused for now; §12.5 lets
  // Free show text and quote only, so any other kind stays hidden on Free.
  const supporters = { id: 'blk00009', kind: 'supporters' };
  for (const style of ['journal', 'stage']) {
    const shown = studioShown(
      doc({
        style,
        blocks: [heading('blk00001'), supporters, quote('blk00003')],
      }),
      'free',
    );
    assert.deepEqual(
      shown.blocks.map((b) => b.kind),
      ['text', 'quote'],
      style,
    );
  }
  assert.equal(
    studioShown(doc({ style: 'classic', blocks: [supporters] }), 'free'),
    null,
  );
  // Pro shows the document as it is.
  const pro = doc({ blocks: [supporters] });
  assert.equal(studioShown(pro, 'pro'), pro);
});

test('what a Free page shows never holds anything Pro, and is never the Classic default', () => {
  fc.assert(
    fc.property(
      studioDocumentArb(),
      fc.constantFrom('free', 'pro'),
      (d, plan) => {
        const shown = studioShown(d, plan);
        if (shown === null) return true;
        if (isClassicDefault(shown)) return false;
        if (plan === 'pro') return shown === d;
        const pro = proItemsOf(shown);
        return !pro.style && !pro.photoAccent && pro.blockIds.length === 0;
      },
    ),
    { seed: seed(), numRuns: runs(200) },
  );
});

test('Classic with every choice back at its default is the standard page', () => {
  // Review Focus 4: TipMe purple (accent null), light, Your cover, every block removed.
  const chosen = doc({
    style: 'classic',
    accent: 'violet',
    mode: 'dark',
    cover: 'gradient',
    blocks: [heading('blk00001'), quote('blk00002')],
  });
  assert.notEqual(studioShown(chosen, 'pro'), null);
  const back = {
    ...chosen,
    accent: null,
    mode: 'light',
    cover: 'yours',
    blocks: [],
  };
  assert.equal(isClassicDefault(back), true);
  for (const plan of ['free', 'pro'])
    assert.equal(studioShown(back, plan), null);
});

test('a Free save may keep or restore Pro items held by the stored draft or published version, and nothing else', () => {
  // A lapsed Pro draft: Stage with the photo accent, a gallery and a video.
  const draft = doc({
    style: 'stage',
    accent: 'photo',
    blocks: [heading('blk00001'), gallery('blk00002'), video('blk00003')],
  });
  const published = doc({
    style: 'clear',
    blocks: [heading('blk00001'), gallery('blk00009', [IMG3])],
  });
  const held = { draft, published };
  const refused = (next, h = held) => studioDraftRefusal(next, h, 'free');
  const ok = (next, h = held) => assert.equal(refused(next, h), null);
  const no = (next, h = held) =>
    assert.equal(refused(next, h), 'STUDIO_PRO_REQUIRED');
  // Pro: nothing is refused.
  assert.equal(
    studioDraftRefusal(
      doc({ style: 'horizon', accent: 'photo', blocks: [gallery('blk00007')] }),
      { draft: null, published: null },
      'pro',
    ),
    null,
  );
  // Reorder, edit text (in a held gallery too), remove: allowed.
  ok({
    ...draft,
    blocks: [video('blk00003'), gallery('blk00002'), heading('blk00001')],
  });
  ok({
    ...draft,
    blocks: [
      heading('blk00001', 'Edited'),
      gallery('blk00002', [IMG2, IMG1], 'Edited description'),
      { ...video('blk00003'), caption: 'Live in Yaba' },
    ],
  });
  ok({ ...draft, blocks: [heading('blk00001')] });
  ok({ ...draft, blocks: [gallery('blk00002', [IMG1])] });
  ok(draft);
  // Leaving the Pro style or accent, and coming back to what is held (undo): allowed.
  ok({ ...draft, style: 'clear', accent: 'blue' });
  ok({ ...draft, style: 'stage', accent: 'photo' });
  // Adding: a new gallery id, a new photo in a held gallery, another video link, a Pro style or the
  // photo accent neither version holds: refused.
  no({ ...draft, blocks: [...draft.blocks, gallery('blk00004')] });
  no({
    ...draft,
    blocks: [heading('blk00001'), gallery('blk00002', [IMG1, IMG2, IMG3])],
  });
  no({
    ...draft,
    blocks: [{ ...video('blk00003'), url: 'https://youtu.be/aaaaaaaaaaa' }],
  });
  no({ ...draft, style: 'horizon' });
  no({
    ...draft,
    blocks: [{ ...gallery('blk00002'), kind: 'photo', imageId: IMG1, alt: '' }],
  });
  const clearDraft = { draft: doc({ style: 'clear' }), published: null };
  no(doc({ style: 'stage' }), clearDraft);
  no(doc({ accent: 'photo' }), clearDraft);
  no(doc({ blocks: [gallery('blk00002')] }), clearDraft);
  // Re-adding a gallery the published version holds: allowed; one neither holds: refused.
  ok({ ...draft, blocks: [...draft.blocks, gallery('blk00009', [IMG3])] });
  no({ ...draft, blocks: [...draft.blocks, gallery('blk00010', [IMG3])] });
  // Free blocks and free styles are always fine.
  ok(
    doc({ style: 'linen', blocks: [quote('blk00011'), paragraph('blk00012')] }),
    {
      draft: null,
      published: null,
    },
  );
});

test('every Pro block kind is gated on Free', () => {
  const none = { draft: null, published: null };
  const samples = {
    photo: { id: 'blk00001', kind: 'photo', imageId: IMG1, alt: 'A photo' },
    gallery: gallery('blk00001'),
    video: video('blk00001'),
    services: {
      id: 'blk00001',
      kind: 'services',
      items: [{ name: 'Fade', priceMinor: '500000' }],
    },
    events: {
      id: 'blk00001',
      kind: 'events',
      items: [{ date: '2099-01-01', title: 'Show' }],
    },
  };
  assert.deepEqual(Object.keys(samples).sort(), [...STUDIO_PRO_BLOCKS].sort());
  for (const [kind, block] of Object.entries(samples)) {
    assert.equal(
      studioDraftRefusal(doc({ blocks: [block] }), none, 'free'),
      'STUDIO_PRO_REQUIRED',
      kind,
    );
    // Held: words may change, nothing may be added.
    const held = { draft: doc({ blocks: [block] }), published: null };
    assert.equal(
      studioDraftRefusal(doc({ blocks: [block] }), held, 'free'),
      null,
      kind,
    );
    if ('items' in block) {
      const more = { ...block, items: [...block.items, block.items[0]] };
      assert.equal(
        studioDraftRefusal(doc({ blocks: [more] }), held, 'free'),
        'STUDIO_PRO_REQUIRED',
        `${kind}: an added item`,
      );
      const edited = {
        ...block,
        items: block.items.map((i) => ({
          ...i,
          ...('name' in i ? { name: 'Line-up' } : { title: 'Gig' }),
        })),
      };
      assert.equal(
        studioDraftRefusal(doc({ blocks: [edited] }), held, 'free'),
        null,
        `${kind}: edited words`,
      );
    }
  }
});

test('a draft save takes a v2 document only; a v1 draft is refused (ruling R1, PR 4a)', () => {
  assert.equal(
    studioDraftSchema.safeParse({
      rev: 1,
      draft: doc({ style: 'journal', blocks: [heading('blk00001')] }),
    }).success,
    true,
  );
  for (const bad of [
    { rev: 0, draft: KEMI },
    { rev: 0, draft: { ...doc(), v: 3 } },
    { rev: 0, draft: { ...doc(), css: 'x' } },
    { rev: 0, draft: { ...doc(), style: 'sprint', cover: 'gradient' } },
    { rev: 0, draft: doc(), extra: true },
  ])
    assert.equal(
      studioDraftSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 60),
    );
});
