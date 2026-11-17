import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_LIMITS,
  checkDesignV1,
  studioDocumentV1Schema,
} from '@tipme/contracts';
import {
  ADD_KINDS,
  addBlock,
  addReasons,
  addRow,
  blockSummary,
  counter,
  fixTarget,
  freshId,
  koboToNaira,
  moveBlock,
  moveRow,
  movedWords,
  nairaToKobo,
  newBlock,
  removeBlock,
  removeRow,
  rowReason,
  rowSummary,
  textVariant,
  updateBlock,
  withBackground,
  withColumns,
  withSpacing,
} from '../src/app/dashboard/studio/blocks-model.ts';

// Page Studio editor, PR G2 (plan 2026-11-12-page-studio, Task 9b): the Blocks tab's pure parts.
// Every edit gives a document the strict schema accepts, so the debounced save never fails on it.

const IMAGE = '0b5c2d9e-6f1a-4c3b-9d8e-7a6b5c4d3e2f';
const text = (id, t = 'Hello') => ({
  id,
  kind: 'text',
  variant: 'paragraph',
  text: t,
});
const row = (id, cells, columns = cells.length === 1 ? '1' : '1-1') => ({
  id,
  columns,
  spacing: 'm',
  background: 'page',
  cells,
});
const doc = (rows = [row('row00001', [[text('blk00001')]])], extra = {}) => ({
  v: 1,
  brand: ['#1d4e89'],
  mode: 'light',
  fonts: { heading: 'fraunces', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows,
  ...extra,
});
const valid = (d) => {
  const parsed = studioDocumentV1Schema.safeParse(d);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
};
const profile = { bio: true, links: 2 };

test('a fresh id is 8 lower-case letters or digits, never one the page already uses', () => {
  const d = doc();
  const seen = new Set(['row00001', 'blk00001']);
  for (let i = 0; i < 200; i += 1) {
    const id = freshId(d, seen);
    assert.match(id, /^[a-z0-9]{8}$/);
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

test('a new row is one column on the page background, added at the end, until 12', () => {
  let d = doc();
  d = addRow(d);
  valid(d);
  assert.equal(d.rows.length, 2);
  assert.deepEqual(
    { ...d.rows[1], id: 'x' },
    { id: 'x', columns: '1', spacing: 'm', background: 'page', cells: [[]] },
  );
  assert.equal(rowReason(d), null);
  while (d.rows.length < STUDIO_LIMITS.rows) d = addRow(d);
  valid(d);
  assert.equal(rowReason(d), 'Your page has 12 rows, the most it can have.');
  assert.equal(addRow(d), d);
});

test('rows move to any position, and say where they went', () => {
  const d = doc([
    row('rowaaaaa', [[]]),
    row('rowbbbbb', [[]]),
    row('rowccccc', [[]]),
  ]);
  const moved = moveRow(d, 2, 0);
  assert.deepEqual(
    moved.rows.map((r) => r.id),
    ['rowccccc', 'rowaaaaa', 'rowbbbbb'],
  );
  assert.equal(movedWords(2, 0, 3), 'Row 3, moved to position 1 of 3');
  // Past either end: nothing changes.
  assert.equal(moveRow(d, 0, -1), d);
  assert.equal(moveRow(d, 2, 3), d);
  assert.equal(moveRow(d, 1, 1), d);
});

test('removing a row removes its blocks', () => {
  const d = removeRow(doc(), 'row00001');
  valid(d);
  assert.deepEqual(d.rows, []);
});

test('columns: more columns add empty ones; fewer move the blocks left, in reading order', () => {
  const d = doc([row('row00001', [[text('blk00001')], [text('blk00002')]])]);
  const three = withColumns(d, 'row00001', '1-1-1');
  valid(three);
  assert.equal(three.rows[0].cells.length, 3);
  assert.deepEqual(three.rows[0].cells[2], []);
  const wide = withColumns(d, 'row00001', '2-1');
  assert.equal(wide.rows[0].columns, '2-1');
  assert.deepEqual(wide.rows[0].cells, d.rows[0].cells);
  const one = withColumns(d, 'row00001', '1');
  valid(one);
  assert.deepEqual(
    one.rows[0].cells.map((c) => c.map((b) => b.id)),
    [['blk00001', 'blk00002']],
  );
});

test('fewer columns than the blocks fit is refused with the reason', () => {
  const full = (p) => [text(`${p}00001`), text(`${p}00002`), text(`${p}00003`)];
  const d = doc([row('row00001', [full('aaa'), full('bbb')])]);
  const result = withColumns(d, 'row00001', '1');
  assert.equal(
    result,
    'This row has 6 blocks, and one column holds 3. Remove 3 blocks or move them to another row first.',
  );
});

test('spacing and background are fixed choices; a photo background is a TipMe image', () => {
  const d = withSpacing(doc(), 'row00001', 'l');
  assert.equal(d.rows[0].spacing, 'l');
  const card = withBackground(d, 'row00001', 'card');
  valid(card);
  assert.equal(card.rows[0].background, 'card');
  const photo = withBackground(d, 'row00001', { photo: IMAGE });
  valid(photo);
  assert.deepEqual(photo.rows[0].background, { photo: IMAGE });
});

test('new blocks: each kind starts with a valid, empty form the check asks to fill', () => {
  for (const kind of ADD_KINDS.map((k) => k.kind)) {
    if (kind === 'photo' || kind === 'video') continue;
    const d = addBlock(doc(), 'row00001', 0, newBlock(kind, 'blknew01'));
    valid(d);
    assert.equal(d.rows[0].cells[0][1].kind, kind);
  }
  const photo = newBlock('photo', 'blknew02', { imageId: IMAGE });
  assert.deepEqual(photo, {
    id: 'blknew02',
    kind: 'photo',
    variant: 'square',
    imageId: IMAGE,
    alt: '',
  });
  const video = newBlock('video', 'blknew03', {
    url: 'https://youtu.be/dQw4w9WgXcQ',
  });
  valid(addBlock(doc(), 'row00001', 0, video));
  const heading = addBlock(doc(), 'row00001', 0, {
    ...newBlock('text', 'blknew04'),
    variant: 'heading',
    level: 2,
  });
  valid(heading);
});

test('Add a block says why a kind can’t be added, at each limit', () => {
  const d = doc();
  assert.deepEqual(addReasons(d, 'row00001', 0, profile), {});
  // A full column.
  const fullCell = doc([
    row('row00001', [[text('blk00001'), text('blk00002'), text('blk00003')]]),
  ]);
  assert.equal(
    addReasons(fullCell, 'row00001', 0, profile).all,
    'This column has 3 blocks, the most one column can hold.',
  );
  // 40 blocks on the page.
  const rows = [];
  let n = 0;
  for (let r = 0; r < 12 && n < 40; r += 1) {
    const cells = [[], [], []];
    for (let c = 0; c < 3 && n < 40; c += 1)
      for (let k = 0; k < 3 && n < 40; k += 1)
        cells[c].push(text(`b${String(n++).padStart(7, '0')}`));
    rows.push(row(`r${String(r).padStart(7, '0')}`, cells, '1-1-1'));
  }
  const forty = doc(rows);
  valid(forty);
  const last = forty.rows.at(-1);
  const roomy = last.cells.findIndex((c) => c.length < 3);
  assert.equal(
    addReasons(forty, last.id, roomy, profile).all,
    'Your page has 40 blocks, the most it can have.',
  );
  // About and links show once; each needs something to show.
  const withAbout = addBlock(d, 'row00001', 0, newBlock('about', 'blkabout'));
  assert.equal(
    addReasons(withAbout, 'row00001', 0, profile).about,
    'About is already on your page. It shows once.',
  );
  assert.equal(
    addReasons(d, 'row00001', 0, { bio: false, links: 0 }).about,
    'Add a bio in My page first. About shows it.',
  );
  assert.equal(
    addReasons(d, 'row00001', 0, { bio: false, links: 0 }).links,
    'Add your links in My page first. This block shows them.',
  );
  // Videos: 3.
  let v = d;
  for (let i = 0; i < 3; i += 1) v = addRow(v);
  v.rows.slice(1).forEach((r, i) => {
    v = addBlock(
      v,
      r.id,
      0,
      newBlock('video', `vid0000${i + 1}`, {
        url: 'https://youtu.be/dQw4w9WgXcQ',
      }),
    );
  });
  valid(v);
  assert.equal(
    addReasons(v, 'row00001', 0, profile).video,
    'Your page has 3 videos, the most it can have.',
  );
});

test('blocks move up and down in their column, and across to the next column', () => {
  const d = doc([
    row('row00001', [[text('blk00001'), text('blk00002')], [text('blk00003')]]),
  ]);
  const down = moveBlock(d, 'blk00001', 'down');
  assert.deepEqual(
    down.rows[0].cells[0].map((b) => b.id),
    ['blk00002', 'blk00001'],
  );
  assert.equal(moveBlock(d, 'blk00002', 'down'), null);
  assert.equal(moveBlock(d, 'blk00001', 'up'), null);
  const right = moveBlock(d, 'blk00001', 'right');
  valid(right);
  assert.deepEqual(
    right.rows[0].cells.map((c) => c.map((b) => b.id)),
    [['blk00002'], ['blk00003', 'blk00001']],
  );
  assert.equal(moveBlock(d, 'blk00003', 'right'), null);
  assert.equal(moveBlock(d, 'blk00001', 'left'), null);
});

test('removing and updating a block keeps the rest', () => {
  const d = doc([row('row00001', [[text('blk00001'), text('blk00002')]])]);
  const removed = removeBlock(d, 'blk00001');
  assert.deepEqual(
    removed.rows[0].cells[0].map((b) => b.id),
    ['blk00002'],
  );
  const updated = updateBlock(d, 'blk00002', (b) => ({ ...b, text: 'Bye' }));
  assert.equal(updated.rows[0].cells[0][1].text, 'Bye');
  assert.equal(updated.rows[0].cells[0][0], d.rows[0].cells[0][0]);
});

test('changing a text block’s style keeps the words, fitted to the new style', () => {
  const long = 'word '.repeat(40).trim();
  const p = { id: 'blk00001', kind: 'text', variant: 'paragraph', text: long };
  const h = textVariant(p, 'heading');
  assert.equal(h.level, 2);
  assert.ok([...h.text].length <= STUDIO_LIMITS.headingText);
  assert.ok(!h.text.endsWith(' '));
  const back = textVariant(h, 'paragraph');
  assert.equal(back.level, undefined);
  assert.equal('level' in back, false);
});

test('counters count characters as people see them', () => {
  assert.equal(counter('Ẹ ọ', 80), '3 of 80');
  assert.equal(counter('x'.repeat(212), 600), '212 of 600');
});

test('prices: whole naira in, kobo stored; anything else is refused', () => {
  assert.equal(nairaToKobo('5000'), '500000');
  assert.equal(nairaToKobo('₦5,000'), '500000');
  assert.equal(nairaToKobo(' 1 '), '100');
  assert.equal(nairaToKobo('10,000,000'), '1000000000');
  for (const bad of ['', '0', '-5', '5.50', 'abc', '10000001', '1e5'])
    assert.equal(nairaToKobo(bad), null, bad);
  assert.equal(koboToNaira('500000'), '5,000');
});

test('rows and blocks are summed up in a few words', () => {
  const d = doc([row('row00001', [[text('blk00001')], []], '2-1')]);
  assert.equal(rowSummary(d.rows[0]), '2 : 1 · 1 block');
  assert.equal(rowSummary(row('row00002', [[]])), 'One column · empty');
  assert.equal(blockSummary(text('blk00001', 'Hello there')), 'Hello there');
  assert.equal(
    blockSummary({ id: 'x', kind: 'services', variant: 'list', items: [] }),
    'No services yet',
  );
});

test('a fix that needs the person’s input opens the block’s form at the right field', () => {
  const d = doc([
    row('row00001', [
      [
        {
          id: 'blk00001',
          kind: 'photo',
          variant: 'square',
          imageId: IMAGE,
          alt: '',
        },
      ],
    ]),
  ]);
  const check = checkDesignV1(d, {
    images: { [IMAGE]: { width: 2000, height: 2000, bytes: {} } },
    videos: {},
    profile,
  });
  const issue = check.issues.find((i) => i.rule === 'photo-alt');
  assert.ok(issue);
  assert.deepEqual(fixTarget(issue, 'add-description'), {
    row: 'row00001',
    block: 'blk00001',
    field: 'alt',
  });
  assert.deepEqual(
    fixTarget({ ...issue, at: { row: 'row00001' } }, 'replace-photo'),
    { row: 'row00001', field: 'background' },
  );
  assert.equal(fixTarget(issue, 'mark-decorative'), null);
  assert.equal(fixTarget(issue, 'change-link').field, 'link');
  assert.equal(fixTarget(issue, 'edit-text').field, 'text');
  assert.equal(fixTarget(issue, 'replace-photo').field, 'photo');
});
