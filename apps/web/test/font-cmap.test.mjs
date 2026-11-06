import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { characterMap, setsIn } from '../src/lib/font-cmap.ts';

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
