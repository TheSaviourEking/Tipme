import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const layout = readFileSync(
  new URL('../src/app/layout.tsx', import.meta.url),
  'utf8',
);
const tokens = readFileSync(
  new URL('../../../packages/ui/src/tokens.css', import.meta.url),
  'utf8',
);
const seed = readFileSync(
  new URL('../../../packages/database/src/seed.ts', import.meta.url),
  'utf8',
);

test('TipMe assigns local build-time fonts to distinct type roles', () => {
  assert.match(layout, /Manrope/);
  assert.match(layout, /DM_Serif_Display/);
  assert.match(layout, /display:\s*'swap'/);
  // The wordmark is an SVG from the master file, so no brand font is downloaded.
  assert.doesNotMatch(layout, /Nunito/);
  assert.doesNotMatch(layout, /weight:\s*\['100'/);

  assert.match(tokens, /--font-interface:\s*var\(--font-manrope\)/);
  assert.match(tokens, /--font-editorial:\s*var\(--font-dm-serif\)/);
  assert.match(tokens, /font-variant-numeric:\s*var\(--numeric-variant\)/);
});

test('the wordmark renders from the master SVG file', () => {
  const brand = readFileSync(
    new URL('../src/lib/wordmark.ts', import.meta.url),
    'utf8',
  );
  const master = readFileSync(
    new URL('../public/brand/tipme-wordmark.svg', import.meta.url),
    'utf8',
  );
  const paths = [...master.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 7);
  for (const d of paths)
    assert.ok(brand.includes(d), 'path missing from the wordmark module');
});

test('fictional demo portraits are optimized repository assets', () => {
  for (const name of ['ada', 'tobi']) {
    const asset = new URL(`../public/portraits/${name}.webp`, import.meta.url);
    assert.equal(existsSync(asset), true, `${name}.webp must exist`);
    assert.ok(statSync(asset).size < 180_000, `${name}.webp exceeds 180 KB`);
    assert.match(seed, new RegExp(`/portraits/${name}\\.webp`));
  }
  assert.doesNotMatch(seed, /\/illustrations\/(ada|tobi)\.svg/);
});
