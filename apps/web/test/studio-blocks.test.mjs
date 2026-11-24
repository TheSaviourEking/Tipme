import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_LIMITS,
  checkDesign,
  studioDocumentSchema,
} from '@tipme/contracts';
import {
  addBlock,
  addKinds,
  addReasons,
  blockSummary,
  counter,
  fixTarget,
  freshId,
  koboToNaira,
  lockedRows,
  moveBlock,
  moveBlockTo,
  movedWords,
  nairaToKobo,
  newBlock,
  removeBlock,
  textVariant,
  updateBlock,
} from '../src/app/dashboard/studio/blocks-model.ts';

// Page Studio editor on v2 (styles plan Task 12, PR 4a): the Blocks tab is one ordered list
// (§10, "The Blocks tab"). Every edit gives a document the strict schema accepts, so the debounced
// save never fails on it. TipMe's own parts are locked rows; there are no columns, spacing,
// backgrounds or variants, and Links is not a block.

const IMAGE = '0b5c2d9e-6f1a-4c3b-9d8e-7a6b5c4d3e2f';
const text = (id, t = 'Hello') => ({
  id,
  kind: 'text',
  variant: 'paragraph',
  text: t,
});
const doc = (blocks = [text('blk00001')]) => ({
  v: 2,
  style: 'clear',
  accent: null,
  mode: 'light',
  cover: 'yours',
  blocks,
});
const valid = (d) => {
  const r = studioDocumentSchema.safeParse(d);
  assert.ok(r.success, JSON.stringify(r.error?.issues?.slice(0, 2)));
};

test('the Blocks list has locked rows "Cover, name and bio", "Tip" and "Your links" (only with links), each "Always TipMe. Can’t be moved or removed."', () => {
  const fixed = 'Always TipMe. Can’t be moved or removed.';
  assert.deepEqual(lockedRows(3), [
    { key: 'identity', title: 'Cover, name and bio', detail: fixed },
    { key: 'tip', title: 'Tip', detail: fixed },
    {
      key: 'links',
      title: 'Your links',
      detail: `${fixed} Change them in Settings.`,
    },
  ]);
  assert.deepEqual(
    lockedRows(0).map((r) => r.title),
    ['Cover, name and bio', 'Tip'],
  );
});

test('"Add a block" never offers Links and marks Pro kinds PRO on Free', () => {
  const free = addKinds('free');
  const kinds = free.map((k) => k.kind);
  assert.deepEqual(kinds, [
    'text',
    'photo',
    'gallery',
    'video',
    'services',
    'events',
    'quote',
  ]);
  assert.ok(!kinds.includes('links'));
  assert.ok(!kinds.includes('about'));
  assert.deepEqual(
    free.filter((k) => k.pro).map((k) => k.kind),
    ['photo', 'gallery', 'video', 'services', 'events'],
  );
  assert.ok(
    addKinds('pro').every((k) => !k.pro),
    'no PRO badge on Pro',
  );
});

test('moving a block announces the same aria-live words as G2', () => {
  assert.equal(movedWords('quote', 0, 3), 'Quote, moved to place 1 of 3');
  assert.equal(movedWords('text', 2, 3), 'Text, moved to place 3 of 3');
});

test('a fresh id is 8 lower-case letters or digits, never one the page already uses', () => {
  const d = doc();
  for (let i = 0; i < 50; i += 1) {
    const id = freshId(d);
    assert.match(id, /^[a-z0-9]{8}$/);
    assert.notEqual(id, 'blk00001');
  }
});

test('new blocks: each kind starts with a valid, empty form the check asks to fill', () => {
  for (const { kind } of addKinds('pro')) {
    if (kind === 'photo' || kind === 'video') continue;
    const d = addBlock(doc(), newBlock(kind, 'blknew01'));
    valid(d);
    assert.equal(d.blocks.at(-1).kind, kind);
  }
  assert.deepEqual(newBlock('photo', 'blknew02', { imageId: IMAGE }), {
    id: 'blknew02',
    kind: 'photo',
    imageId: IMAGE,
    alt: '',
  });
  valid(
    addBlock(
      doc(),
      newBlock('video', 'blknew03', { url: 'https://youtu.be/dQw4w9WgXcQ' }),
    ),
  );
  assert.deepEqual(newBlock('text', 'blknew04'), {
    id: 'blknew04',
    kind: 'text',
    variant: 'paragraph',
    text: '',
  });
});

test('Add a block says why a kind can’t be added, at each limit', () => {
  assert.deepEqual(addReasons(doc()), {});
  const forty = doc(
    Array.from({ length: STUDIO_LIMITS.blocks }, (_, i) =>
      text(`b${String(i).padStart(7, '0')}`),
    ),
  );
  valid(forty);
  assert.equal(
    addReasons(forty).all,
    'Your page has 40 blocks, the most it can have.',
  );
  let v = doc();
  for (let i = 0; i < 3; i += 1)
    v = addBlock(
      v,
      newBlock('video', `vid0000${i + 1}`, {
        url: 'https://youtu.be/dQw4w9WgXcQ',
      }),
    );
  valid(v);
  assert.equal(
    addReasons(v).video,
    'Your page has 3 videos, the most it can have.',
  );
});

test('blocks move up and down, to any place by drag, and say where they went', () => {
  const d = doc([text('blk00001'), text('blk00002'), text('blk00003')]);
  const down = moveBlock(d, 'blk00001', 'down');
  assert.deepEqual(
    down.blocks.map((b) => b.id),
    ['blk00002', 'blk00001', 'blk00003'],
  );
  assert.equal(moveBlock(d, 'blk00001', 'up'), null, 'already first');
  assert.equal(moveBlock(d, 'blk00003', 'down'), null, 'already last');
  assert.deepEqual(
    moveBlockTo(d, 0, 2).blocks.map((b) => b.id),
    ['blk00002', 'blk00003', 'blk00001'],
  );
  assert.equal(moveBlockTo(d, 1, 1), d);
  assert.equal(moveBlockTo(d, 0, 5), d);
  valid(down);
});

test('removing and updating a block keeps the rest', () => {
  const d = doc([text('blk00001'), text('blk00002')]);
  assert.deepEqual(
    removeBlock(d, 'blk00001').blocks.map((b) => b.id),
    ['blk00002'],
  );
  const updated = updateBlock(d, 'blk00002', (b) => ({ ...b, text: 'New' }));
  assert.equal(updated.blocks[1].text, 'New');
  assert.equal(updated.blocks[0], d.blocks[0]);
});

test('a text block is a heading or a paragraph; switching fits the words', () => {
  const long = text('blk00001', 'x'.repeat(300));
  const heading = textVariant(long, 'heading');
  assert.equal(heading.variant, 'heading');
  assert.equal([...heading.text].length, STUDIO_LIMITS.headingText);
  assert.equal(heading.level, undefined, 'no heading level in v2');
  valid(doc([heading]));
  const back = textVariant(heading, 'paragraph');
  assert.equal(back.variant, 'paragraph');
  valid(doc([back]));
});

test('counters count characters as people see them', () => {
  assert.equal(counter('Ẹ ọ', 80), '3 of 80');
  assert.equal(counter('x'.repeat(212), 600), '212 of 600');
});

test('prices: whole naira in, kobo stored; anything else is refused', () => {
  assert.equal(nairaToKobo('5000'), '500000');
  assert.equal(nairaToKobo('₦5,000'), '500000');
  assert.equal(nairaToKobo(' 1 '), '100');
  for (const bad of ['', '0', '-5', '5.50', 'abc', '10000001', '1e5'])
    assert.equal(nairaToKobo(bad), null, bad);
  assert.equal(koboToNaira('500000'), '5,000');
});

test('blocks are summed up in a few words', () => {
  assert.equal(blockSummary(text('blk00001', 'Hello there')), 'Hello there');
  assert.equal(
    blockSummary({ id: 'x', kind: 'services', items: [] }),
    'No services yet',
  );
  assert.equal(
    blockSummary({ id: 'x', kind: 'gallery', images: [] }),
    'No photos yet',
  );
});

test('a fix that needs the person’s input opens the block’s form at the right field', () => {
  const d = doc([{ id: 'blk00001', kind: 'photo', imageId: IMAGE, alt: '' }]);
  const check = checkDesign(d, {
    images: { [IMAGE]: { width: 2400, height: 2400, bytes: 100_000 } },
    videos: {},
    profile: { name: 'Kemi', bio: true, links: 1 },
    plan: 'pro',
    coverKind: 'photo',
    hasAvatar: true,
  });
  const issue = check.issues.find((i) => i.rule === 'photo-alt');
  assert.ok(issue);
  assert.deepEqual(fixTarget(issue, 'add-description'), {
    block: 'blk00001',
    field: 'alt',
  });
  assert.equal(fixTarget(issue, 'mark-decorative'), null);
  assert.equal(fixTarget(issue, 'change-link').field, 'link');
  assert.equal(fixTarget(issue, 'shorter-heading').field, 'text');
  assert.equal(fixTarget(issue, 'replace-photo').field, 'photo');
  assert.equal(
    fixTarget({ ...issue, at: { row: 'style' } }, 'replace-photo'),
    null,
  );
});
