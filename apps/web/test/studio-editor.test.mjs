import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  STUDIO_ERROR_RULES,
  STUDIO_FIX_NEEDS_INPUT,
  checkDesignV1,
  contrastRatio,
  deriveStudioPalette,
  studioDocumentV1Schema,
} from '@tipme/contracts';
import {
  checkShown,
  colourNotes,
  colourUse,
  fontChoices,
  fixesInput,
  fixesNow,
  formatRatio,
  normaliseHex,
  paletteChips,
  passingWords,
  saveWords,
  studioEntry,
  withFont,
  withSecondColour,
} from '../src/app/dashboard/studio/studio-editor-model.ts';

// Page Studio editor, PR G1 (plan 2026-11-12-page-studio, Task 9a): the editor's pure parts.

const doc = (extra = {}) => ({
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
        [{ id: 'blk00001', kind: 'text', variant: 'lead', text: 'Hello' }],
      ],
    },
  ],
  ...extra,
});
const ctx = { images: {}, videos: {}, profile: { bio: false, links: 0 } };

test('a typed colour becomes #rrggbb, or nothing when it is not a colour', () => {
  assert.equal(normaliseHex('#F5C400'), '#f5c400');
  assert.equal(normaliseHex('  f5c400 '), '#f5c400');
  assert.equal(normaliseHex('#abc'), '#aabbcc');
  assert.equal(normaliseHex('abc'), '#aabbcc');
  for (const bad of ['', '#', '#12345', '#gggggg', 'red', '#1234567', 'f5c40'])
    assert.equal(normaliseHex(bad), null, bad);
});

test('ratios read as the board writes them', () => {
  assert.equal(formatRatio(15.04), '15.0 : 1');
  assert.equal(formatRatio(4.5), '4.5 : 1');
  assert.equal(formatRatio(21), '21.0 : 1');
});

test('the palette chips are the engine’s colours, each text pair with its live ratio', () => {
  const palette = deriveStudioPalette(['#0f2238', '#ff7a59']);
  for (const mode of ['light', 'dark']) {
    const chips = paletteChips(palette, mode);
    assert.deepEqual(
      chips.map((c) => c.label),
      [
        'Page',
        'Card',
        'Text',
        'Quiet text',
        'Accent',
        'Lines',
        'Links',
        'Focus ring',
      ],
    );
    const t = palette[mode];
    const text = chips.find((c) => c.label === 'Text');
    assert.equal(text.hex, t.text);
    assert.equal(text.ratio, contrastRatio(t.text, t.page));
    assert.ok(text.ratio >= 4.5);
    assert.equal(chips.find((c) => c.label === 'Lines').ratio, null);
    assert.equal(chips.find((c) => c.label === 'Page').ratio, null);
    for (const chip of chips)
      if (chip.ratio !== null)
        assert.ok(chip.ratio >= chip.min, `${mode} ${chip.label}`);
  }
});

test('a yellow that can’t carry text: the board’s sentence, and how it is used', () => {
  const d = doc({ brand: ['#f5c400'] });
  const check = checkDesignV1(d, ctx);
  const notes = colourNotes(check);
  assert.equal(notes.length, 1);
  assert.equal(
    notes[0].lead,
    'Your yellow is too light for text on a light page.',
  );
  assert.equal(
    notes[0].rest,
    'We’ll use it for highlights and for buttons with dark text, and a deeper shade of it for links and headings. Your page will still look yellow.',
  );
  const use = colourUse(
    deriveStudioPalette(['#f5c400']),
    'light',
    0,
    '#f5c400',
  );
  assert.deepEqual(
    use.map((u) => [u.label, u.used]),
    [
      ['Buttons', true],
      ['Links', true],
      ['As text', false],
    ],
  );
  assert.ok(use[0].ratio >= 4.5 && use[1].ratio >= 4.5 && use[2].ratio < 3);
  // A colour that carries text needs no note.
  assert.deepEqual(colourNotes(checkDesignV1(doc(), ctx)), []);
});

test('font pickers offer each family only for a role it can take', () => {
  const headings = fontChoices('heading');
  const texts = fontChoices('body');
  assert.ok(headings.some((f) => f.id === 'dm-serif-display'));
  assert.ok(!texts.some((f) => f.id === 'dm-serif-display'));
  assert.ok(texts.every((f) => f.roles.includes('body')));
  assert.ok(headings.every((f) => f.roles.includes('heading')));
});

test('picking a font replaces its slot, so a page never has a third family', () => {
  const d = withFont(doc(), 'heading', 'space-grotesk');
  assert.deepEqual(d.fonts, { heading: 'space-grotesk', body: 'inter' });
  const e = withFont(d, 'body', 'source-serif-4');
  assert.deepEqual(e.fonts, {
    heading: 'space-grotesk',
    body: 'source-serif-4',
  });
  assert.equal(new Set(Object.values(e.fonts)).size <= 2, true);
  // A family can't take a role it doesn't have: nothing changes.
  assert.deepEqual(
    withFont(doc(), 'body', 'dm-serif-display').fonts,
    doc().fonts,
  );
  assert.ok(studioDocumentV1Schema.safeParse(e).success);
});

test('removing the second colour keeps the document valid: its rows take the main colour', () => {
  const two = doc({
    brand: ['#1d4e89', '#ff7a59'],
    rows: [{ ...doc().rows[0], background: 'second' }],
  });
  assert.ok(studioDocumentV1Schema.safeParse(two).success);
  const one = withSecondColour(two, null);
  assert.deepEqual(one.brand, ['#1d4e89']);
  assert.equal(one.rows[0].background, 'colour');
  assert.ok(studioDocumentV1Schema.safeParse(one).success);
  assert.deepEqual(withSecondColour(doc(), '#ff7a59').brand, [
    '#1d4e89',
    '#ff7a59',
  ]);
});

test('the shown check is the server’s for the document it checked, the editor’s otherwise', () => {
  const d = doc();
  const server = { ...checkDesignV1(d, ctx), weightBytes: 1 };
  const local = checkDesignV1(d, ctx);
  assert.equal(
    checkShown(d, local, { doc: JSON.stringify(d), check: server }),
    server,
  );
  const edited = doc({ corners: 'round' });
  assert.equal(
    checkShown(edited, local, { doc: JSON.stringify(d), check: server }),
    local,
  );
  assert.equal(checkShown(d, local, null), local);
});

test('one-click fixes apply at once; fixes that need the person’s input open the Blocks tab (G2)', () => {
  const issue = {
    rule: 'photo-resolution',
    severity: 'error',
    at: { row: 'r', block: 'b' },
    message: 'A photo will look blurry',
    fixes: [
      { id: 'smaller-slot', label: 'Make the photo smaller' },
      { id: 'replace-photo', label: 'Replace photo' },
    ],
  };
  assert.deepEqual(
    fixesNow(issue).map((f) => f.id),
    ['smaller-slot'],
  );
  assert.deepEqual(
    fixesInput(issue).map((f) => f.id),
    ['replace-photo'],
  );
  assert.ok(STUDIO_FIX_NEEDS_INPUT.includes('replace-photo'));
});

test('every rule has words in the passing list', () => {
  const check = checkDesignV1(doc(), ctx);
  const words = passingWords(check, doc());
  assert.equal(words.length, STUDIO_ERROR_RULES.length);
  assert.ok(words.includes('Text is readable (light and dark)'));
  assert.ok(words.includes('Fits phones from 320 px'));
  assert.ok(words.includes('Fonts: 2 families'));
  assert.ok(words.some((w) => /^Page weight: \d+ KB of 1\.5 MB$/.test(w)));
});

test('the save line says where the draft is', () => {
  assert.equal(saveWords('saved', false), 'Not published yet · Draft saved');
  assert.equal(
    saveWords('saving', true),
    'Changes not published yet · Saving…',
  );
  assert.equal(
    saveWords('failed', true),
    'Changes not published yet · Not saved',
  );
  assert.equal(saveWords('saved', 'same'), 'Your page shows this design');
});

test('the dashboard entry: hidden while the switch is off; Pro opens the editor; Free sees Pro', () => {
  assert.equal(studioEntry({ status: 404 }), null);
  assert.equal(studioEntry({ status: 500 }), null);
  assert.equal(studioEntry({ status: 200, access: 'edit' }), 'edit');
  assert.equal(studioEntry({ status: 200, access: 'preview' }), 'pro');
  assert.equal(studioEntry({ status: 200, access: 'lapsed' }), 'lapsed');
});

test('the editor never writes markup from text, and names no payment provider', () => {
  const dir = new URL('../src/app/dashboard/studio/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, file);
    assert.doesNotMatch(source, /paystack|flutterwave|monnify/i, file);
    assert.doesNotMatch(source, /@handle\b/, file);
  }
});

test('the renderer the preview uses has no server-only imports', () => {
  const dir = new URL('../src/components/studio/', import.meta.url);
  for (const file of readdirSync(dir).filter(
    (f) => f.endsWith('.tsx') || f.endsWith('.ts'),
  )) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(
      source,
      /from '(server-only|next\/headers|next\/server|node:[a-z]+)'/,
      file,
    );
  }
});
