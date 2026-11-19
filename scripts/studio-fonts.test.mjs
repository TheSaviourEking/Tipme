import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  STUDIO_FONTS,
  STUDIO_REQUIRED_CODEPOINTS,
} from '../packages/contracts/dist/index.js';
import {
  woff2CharacterMap,
  woff2NameStrings,
} from '../apps/web/src/lib/font-cmap.ts';
import { LEGACY_BODY_WORD_FALLBACK } from '../packages/contracts/test/support/studio-legacy-body-fonts.mjs';
import { OUT_DIR, SOURCES, licenceName, outputName } from './studio-fonts.mjs';

const PUBLIC = new URL('../apps/web/public', import.meta.url);
const bytesOf = (path) => readFileSync(new URL(`.${path}`, `${PUBLIC.href}/`));
const hexOf = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;

test('every library font draws every required character (body) or is marked wordFallback (heading-only)', () => {
  for (const f of STUDIO_FONTS)
    for (const file of f.files) {
      const map = woff2CharacterMap(bytesOf(file.path));
      const missing = STUDIO_REQUIRED_CODEPOINTS.filter((c) => !map.has(c));
      if (f.roles.includes('body') && !LEGACY_BODY_WORD_FALLBACK.includes(f.id))
        assert.deepEqual(missing, [], `${f.id} misses ${missing.map(hexOf)}`);
      else if (missing.length)
        assert.ok(
          f.wordFallback,
          `${f.id} needs wordFallback (${missing.map(hexOf)})`,
        );
      else assert.equal(f.wordFallback, false, `${f.id} draws everything`);
      for (const c of 'AZaz09 ')
        assert.ok(map.has(c.codePointAt(0)), `${f.id} has no ${c}`);
    }
});

test('the registry bytes match the files, and no file exceeds 100 KB', () => {
  for (const f of STUDIO_FONTS)
    for (const file of f.files) {
      const size = bytesOf(file.path).length;
      assert.equal(file.bytes, size, `${file.path} is ${size} bytes`);
      assert.ok(size <= 100_000, `${file.path} is ${size} bytes`);
    }
});

test('every style page stays within 2 families, 4 files and 200 KB', () => {
  const inter = STUDIO_FONTS.find((f) => f.id === 'inter');
  for (const id of [
    null,
    'source-serif-4',
    'unbounded',
    'anton',
    'linen-serif',
  ]) {
    const own = id === null ? [] : STUDIO_FONTS.find((f) => f.id === id).files;
    const files = [...inter.files, ...own];
    assert.ok(files.length <= 4, `${id}: ${files.length} files`);
    assert.ok(
      files.reduce((sum, file) => sum + file.bytes, 0) <= 204_800,
      `${id}: over 200 KB`,
    );
    for (const file of files)
      assert.ok(file.bytes <= 102_400, `${file.path}: ${file.bytes} bytes`);
  }
});

test('every font has a licence file beside it', () => {
  for (const s of SOURCES) {
    const text = readFileSync(new URL(licenceName(s), OUT_DIR), 'utf8');
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/i, s.id);
  }
});

test('the build script and the registry describe the same files, and nothing else ships', () => {
  const shipped = readdirSync(OUT_DIR)
    .filter((n) => n.endsWith('.woff2'))
    .sort();
  const registry = STUDIO_FONTS.flatMap((f) =>
    f.files.map((file) => file.path.split('/').pop()),
  ).sort();
  assert.deepEqual(shipped, registry);
  assert.deepEqual(SOURCES.map(outputName).sort(), registry);
  assert.deepEqual(
    [...new Set(SOURCES.map((s) => s.id))].sort(),
    STUDIO_FONTS.map((f) => f.id).sort(),
  );
  for (const f of STUDIO_FONTS)
    assert.deepEqual(
      f.files.map((file) => `${file.weight} ${file.style}`).sort(),
      SOURCES.filter((s) => s.id === f.id)
        .map((s) => `${s.weight} ${s.style ?? 'normal'}`)
        .sort(),
      f.id,
    );
});

test('no shipped family carries a Reserved Font Name it would need permission to use on a subset', () => {
  // OFL 1.1 §3: a Modified Version (a subset or an instance is one) may not use a Reserved Font
  // Name without written permission. A family whose own name contains its RFN is not shipped,
  // unless it is renamed: then no name record of any of its files may carry the reserved words.
  for (const s of SOURCES) {
    const text = readFileSync(new URL(licenceName(s), OUT_DIR), 'utf8');
    const f = STUDIO_FONTS.find((x) => x.id === s.id);
    for (const [, name] of text.matchAll(
      /Reserved Font Names? ["“'‘]?([^"”'’.\n]+)/g,
    ))
      assert.ok(
        !f.name.toLowerCase().includes(name.trim().toLowerCase()),
        `${f.name}: reserved font name "${name.trim()}"`,
      );
  }
  const linen = STUDIO_FONTS.find((f) => f.id === 'linen-serif');
  assert.equal(linen.files.length, 3);
  for (const file of linen.files) {
    const records = woff2NameStrings(bytesOf(file.path));
    assert.ok(records.length > 0, `${file.path} has no name records`);
    assert.ok(
      records.includes('Linen Serif'),
      `${file.path}: no "Linen Serif"`,
    );
    for (const record of records)
      assert.ok(
        !/gentium/i.test(record) && !record.includes('SIL'),
        `${file.path}: name record "${record}"`,
      );
  }
});

test('Linen Serif keeps the original copyright and Reserved Font Names in its licence text', () => {
  const text = readFileSync(
    new URL('OFL-GentiumBookPlus.txt', OUT_DIR),
    'utf8',
  );
  assert.match(text, /Copyright \(c\) 2003-2022 SIL International/);
  assert.match(text, /Reserved Font Names "Gentium" and "SIL"/);
});

test('each font lists exactly the required characters it cannot draw', () => {
  for (const f of STUDIO_FONTS) {
    const map = woff2CharacterMap(bytesOf(f.files[0].path));
    const missing = STUDIO_REQUIRED_CODEPOINTS.filter((c) => !map.has(c));
    assert.deepEqual([...f.missing], missing, f.id);
    assert.equal(f.wordFallback, missing.length > 0, f.id);
  }
});
