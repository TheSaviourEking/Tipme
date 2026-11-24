import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MARK, WORDMARK } from '../src/lib/wordmark.ts';

const file = (path) => readFile(new URL(`../${path}`, import.meta.url));
const text = async (path) => (await file(path)).toString('utf8');

/** Width and height from a PNG's IHDR chunk (bytes 16–23). */
async function pngSize(path) {
  const body = await file(path);
  assert.equal(body.subarray(1, 4).toString('latin1'), 'PNG', path);
  return [body.readUInt32BE(16), body.readUInt32BE(20)];
}

test('the logo is the owner’s files, at the sizes wordmark.ts states', async () => {
  for (const src of [WORDMARK.light, WORDMARK.dark])
    assert.deepEqual(await pngSize(`public${src}`), [
      WORDMARK.width,
      WORDMARK.height,
    ]);
  assert.deepEqual(await pngSize(`public${MARK.src}`), [
    MARK.width,
    MARK.height,
  ]);
});

test('the site draws the logo from masks of the same proportions', async () => {
  const css = await text('src/app/globals.css');
  for (const [name, art] of [
    ['wordmark', WORDMARK],
    ['mark', MARK],
  ]) {
    const masks = await Promise.all(
      ['ink', 'accent'].map((part) =>
        pngSize(`public/brand/tipme-${name}-${part}.png`),
      ),
    );
    assert.deepEqual(masks[0], masks[1], name);
    // The same shape to within a pixel of rounding.
    const [w, h] = masks[0];
    assert.ok(
      Math.abs(w - (h * art.width) / art.height) < 1,
      `${name} ${w}x${h}`,
    );
    for (const part of ['ink', 'accent'])
      assert.match(
        css,
        new RegExp(`url\\('/brand/tipme-${name}-${part}\\.png'\\)`),
      );
  }
  assert.match(css, /\.wordmark \{\s*aspect-ratio: 1383 \/ 380;/);
  assert.match(css, /\.brandmark \{\s*aspect-ratio: 400 \/ 380;/);
});

test('every icon the layout and the manifest name is a PNG of its stated size', async () => {
  const layout = await text('src/app/layout.tsx');
  const manifest = await text('src/app/manifest.ts');
  const named = [
    ...[...layout.matchAll(/url: '(\/icons\/[^']+)',\s*sizes: '(\d+)x\d+'/g)],
    ...[...manifest.matchAll(/src: '(\/icons\/[^']+)',\s*sizes: '(\d+)x\d+'/g)],
  ].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(named.map(([src]) => src).sort(), [
    '/icons/192.png',
    '/icons/512-maskable.png',
    '/icons/apple-touch-icon.png',
    '/icons/favicon-32.png',
    '/icons/favicon-48.png',
  ]);
  for (const [src, side] of named)
    assert.deepEqual(await pngSize(`public${src}`), [side, side], src);
});

test('the old drawn logo and icons are gone', async () => {
  for (const path of [
    'src/app/icon.svg',
    'src/app/apple-icon.tsx',
    'src/lib/app-icons.tsx',
    'public/brand/tipme-wordmark.svg',
  ])
    await assert.rejects(file(path), { code: 'ENOENT' }, path);
  for (const path of [
    'src/components/brand.tsx',
    'src/lib/share-card.tsx',
    'src/app/coming-soon/page.tsx',
    'src/app/coming-soon/opengraph-image.tsx',
    'src/app/preview-login/route.ts',
    'src/components/account/claim-moment.tsx',
  ])
    assert.doesNotMatch(
      await text(path),
      /HEART_MARK|WORDMARK_PATHS|M701\.259/,
      path,
    );
});
