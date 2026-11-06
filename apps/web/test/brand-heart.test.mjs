import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { HEART_MARK } from '../src/lib/wordmark.ts';

// brand.tsx re-exports HEART_MARK; the data lives in lib/wordmark.ts so this test can load it.
test('icon.svg draws the HEART_MARK path and transform', async () => {
  const svg = await readFile(
    new URL('../src/app/icon.svg', import.meta.url),
    'utf8',
  );
  const path = /<path\b([^>]*)\/>/.exec(svg)?.[1] ?? '';
  const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(path)?.[1];
  assert.equal(attr('d'), HEART_MARK.d);
  assert.equal(attr('transform'), HEART_MARK.transform);
  assert.equal(/viewBox="([^"]*)"/.exec(svg)?.[1], HEART_MARK.viewBox);
});

test('brand.tsx re-exports the same heart', async () => {
  const source = await readFile(
    new URL('../src/components/brand.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /export \{[^}]*\bHEART_MARK\b[^}]*\}/);
});
