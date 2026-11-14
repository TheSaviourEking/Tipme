import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  characterMap,
  setsIn,
  woff2CharacterMap,
} from '../src/lib/font-cmap.ts';

const font = (name) =>
  readFileSync(new URL(`../src/fonts/og/${name}`, import.meta.url));

test('characterMap reads the letters a TrueType font draws', () => {
  const serif = characterMap(font('DMSerifDisplay-Regular.ttf'));
  const sans = characterMap(font('Manrope-Bold.ttf'));
  for (const letter of 'Aaé’ ') assert.ok(serif.has(letter.codePointAt(0)));
  // DM Serif Display has no Ọ or Ẹ; Manrope has both.
  assert.equal(serif.has(0x1ecc), false);
  assert.equal(serif.has(0x1eb8), false);
  assert.ok(sans.has(0x1ecc) && sans.has(0x1eb8));
});

test('setsIn: a name is set in a font only when it draws every letter', () => {
  const serif = characterMap(font('DMSerifDisplay-Regular.ttf'));
  assert.equal(setsIn('Ada Okafor', serif), true);
  assert.equal(setsIn('Zoë O’Brien-Søren', serif), true);
  assert.equal(setsIn('Ọlápéjú Ẹ̀kọ́', serif), false);
  assert.equal(setsIn('Ada 😀', serif), false);
});

test('woff2CharacterMap reads the cmap of a WOFF2 font (brotli, transformed glyf/loca)', () => {
  const woff2 = (name) =>
    readFileSync(new URL(`../src/fonts/${name}`, import.meta.url));
  // Counts as fontTools reports them for the shipped interface fonts.
  const manrope = woff2CharacterMap(woff2('Manrope-Latin.woff2'));
  const serif = woff2CharacterMap(woff2('DMSerifDisplay-Latin.woff2'));
  assert.equal(manrope.size, 373);
  assert.equal(serif.size, 311);
  for (const letter of 'Aaé’ ') assert.ok(serif.has(letter.codePointAt(0)));
  assert.equal(serif.has(0x1ecc), false);
  assert.throws(
    () => woff2CharacterMap(font('Manrope-Bold.ttf')),
    /not a WOFF2/,
  );
});
