import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// next/og (Satori) reads TrueType, OpenType and WOFF, not the WOFF2 the pages use, so the share
// cards carry their own static copies of the same two fonts.
const dir = new URL('../src/fonts/og/', import.meta.url);
const FONTS = [
  'DMSerifDisplay-Regular.ttf',
  'Manrope-SemiBold.ttf',
  'Manrope-Bold.ttf',
];

test('each share-card font is a TrueType file with its licence beside it', () => {
  for (const name of FONTS) {
    const file = new URL(name, dir);
    assert.ok(existsSync(file), `${name} is missing`);
    assert.deepEqual(
      [...readFileSync(file).subarray(0, 4)],
      [0x00, 0x01, 0x00, 0x00],
      `${name} is not TrueType`,
    );
    assert.ok(statSync(file).size < 400 * 1024, `${name} is over 400 KB`);
  }
  for (const licence of ['OFL-DMSerifDisplay.txt', 'OFL-Manrope.txt']) {
    const text = readFileSync(new URL(licence, dir), 'utf8');
    assert.match(text, /SIL Open Font License, Version 1\.1/);
  }
});
