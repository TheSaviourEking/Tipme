import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  STUDIO_FONTS,
  STUDIO_REQUIRED_CODEPOINTS,
} from '../packages/contracts/dist/index.js';
import { woff2CharacterMap } from '../apps/web/src/lib/font-cmap.ts';
import { OUT_DIR, SOURCES, licenceName, outputName } from './studio-fonts.mjs';

const PUBLIC = new URL('../apps/web/public', import.meta.url);
const bytesOf = (path) => readFileSync(new URL(`.${path}`, `${PUBLIC.href}/`));
const hexOf = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;

test('every library font draws every required character (body) or is marked wordFallback (heading-only)', () => {
  for (const f of STUDIO_FONTS)
    for (const file of f.files) {
      const map = woff2CharacterMap(bytesOf(file.path));
      const missing = STUDIO_REQUIRED_CODEPOINTS.filter((c) => !map.has(c));
      if (f.roles.includes('body'))
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

test('any two families stay within 4 files and 200 KB', () => {
  const total = (f) => f.files.reduce((sum, file) => sum + file.bytes, 0);
  for (const a of STUDIO_FONTS)
    for (const b of STUDIO_FONTS) {
      const families = a.id === b.id ? [a] : [a, b];
      assert.ok(families.flatMap((f) => f.files).length <= 4);
      assert.ok(
        families.reduce((sum, f) => sum + total(f), 0) <= 200_000,
        `${a.id} + ${b.id}`,
      );
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
    SOURCES.map((s) => s.id).sort(),
    STUDIO_FONTS.map((f) => f.id).sort(),
  );
  for (const s of SOURCES) {
    const f = STUDIO_FONTS.find((x) => x.id === s.id);
    assert.deepEqual(
      f.files.map((file) => file.weight),
      [s.weight],
      s.id,
    );
  }
});

test('no shipped family carries a Reserved Font Name it would need permission to use on a subset', () => {
  // OFL 1.1 §3: a Modified Version (a subset or an instance is one) may not use a Reserved Font
  // Name without written permission. A family whose own name contains its RFN is not shipped.
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
});
