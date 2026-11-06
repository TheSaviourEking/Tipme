import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// share-card.tsx is TSX with `@/` imports, which node can't load as it is. Transpile it (and the
// wordmark it draws the heart from) into a cache folder inside the app, so `@tipme/contracts`
// resolves as it does for the app.
const src = new URL('../src/', import.meta.url);
const out = new URL('../node_modules/.cache/share-card-test/', import.meta.url);
mkdirSync(out, { recursive: true });
function build(from, to) {
  const js = ts
    .transpileModule(readFileSync(new URL(from, src), 'utf8'), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replaceAll("'@/lib/wordmark'", "'./wordmark.mjs'");
  writeFileSync(new URL(to, out), js);
}
build('lib/wordmark.ts', 'wordmark.mjs');
build('lib/share-card.tsx', 'share-card.mjs');
const { personCardInput, shareCardColours, initialsOf } = await import(
  pathToFileURL(new URL('share-card.mjs', out).pathname).href
);
const { COVER_COLOURS } = await import('@tipme/contracts');

const PURPLE = { band: '#7a32f9', face: '#5415c9' };
const colour = (id) => COVER_COLOURS.find((c) => c.id === id);

test('personCardInput keeps only name, role, handle and the two colours', () => {
  const result = personCardInput({
    handle: 'ada',
    displayName: 'Ada Okafor',
    role: 'Barista',
    craft: 'Coffee',
    note: 'A pinned note',
    avatarPath: '/v1/avatars/ada.webp',
    bio: 'Private-ish words',
    links: [{ kind: 'website', url: 'https://example.com' }],
    phone: '+2348000000000',
    email: 'ada@example.com',
    celebration: { momentId: 'm1', label: 'Birthday' },
    tipAmounts: { presetsMinor: ['200000'], minMinor: '200000' },
    acceptingTips: true,
    cover: { kind: 'design', design: 'scattered', colour: 'forest' },
    plan: 'pro',
    tippingOpen: true,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'band',
    'face',
    'handle',
    'name',
    'role',
  ]);
  assert.deepEqual(result, {
    name: 'Ada Okafor',
    role: 'Barista',
    handle: 'ada',
    band: colour('forest').base,
    face: colour('forest').tone,
  });
});

test('a role that is not public stays out', () => {
  assert.equal(
    personCardInput({ handle: 'ada', displayName: 'Ada' }).role,
    null,
  );
  assert.equal(
    personCardInput({ handle: 'ada', displayName: 'Ada', role: '  ' }).role,
    null,
  );
});

test('shareCardColours: a design with a colour uses that colour', () => {
  for (const id of ['violet', 'forest', 'ocean', 'rose', 'sun', 'neutral']) {
    assert.deepEqual(
      shareCardColours({ kind: 'design', design: 'large', colour: id }),
      { band: colour(id).base, face: colour(id).tone },
    );
  }
  assert.deepEqual(
    shareCardColours({
      kind: 'animated',
      animation: 'rising',
      colour: 'ocean',
      play: 'once',
    }),
    { band: colour('ocean').base, face: colour('ocean').tone },
  );
});

test('shareCardColours: a photo, a colourless design, an animation without colour, or no cover is TipMe purple', () => {
  assert.deepEqual(
    shareCardColours({ kind: 'photo', path: '/v1/covers/x.webp' }),
    PURPLE,
  );
  assert.deepEqual(
    shareCardColours({ kind: 'design', design: 'danfo' }),
    PURPLE,
  );
  assert.deepEqual(
    shareCardColours({ kind: 'design', design: 'dark' }),
    PURPLE,
  );
  assert.deepEqual(
    shareCardColours({ kind: 'animated', animation: 'rising', play: 'once' }),
    PURPLE,
  );
  assert.deepEqual(shareCardColours(undefined), PURPLE);
  // A colour id this build does not know (a newer API) is purple, not a crash.
  assert.deepEqual(
    shareCardColours({ kind: 'design', design: 'large', colour: 'teal' }),
    PURPLE,
  );
});

test('initials: first and last word, capitals, whole letters', () => {
  assert.equal(initialsOf('Ada Okafor'), 'AO');
  assert.equal(initialsOf('ada'), 'A');
  assert.equal(initialsOf('  Mary  Jane   Watson '), 'MW');
  assert.equal(initialsOf('Ọlápéjú Ẹ̀kọ́'), 'ỌẸ̀');
  assert.equal(initialsOf('😀 Smile'), '😀S');
  assert.equal(initialsOf(''), '');
});
