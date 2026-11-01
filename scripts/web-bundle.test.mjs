import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The Pro QR designs are drawn only by the API (design spec section 7): nothing that draws one,
// and none of the card artwork, may reach the web app. This runs after the web build (the unit
// job builds everything first) and scans what was really built, so it cannot pass on a stale or
// missing build: the build must also contain code that is in this checkout today.
const root = fileURLToPath(new URL('../', import.meta.url));
const next = join(root, 'apps/web/.next');

function walk(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}

// Literals a minifier cannot rename: path data, palettes and the preview mark, one or more from
// every recipe family in the renderer.
const DRAWING_LITERALS = [
  'M.09 .86C.07', // heart module
  'M0 100V0H30C62 0 62 52', // the "Preview" mark's letters
  'M26 82V18L74 82V18', // the naira sign
  '#8f2746', // stitch, dusk
  '#7a2a12', // chips
  '#123527', // contour, circles
  '#a82a55', // dusk gradient
  'c9aeff', // raised keys
];

test('the renderer still holds every literal this test looks for (so the test cannot rot)', () => {
  const source = readFileSync(join(root, 'apps/api/src/qr/render.ts'), 'utf8');
  for (const literal of DRAWING_LITERALS)
    assert.ok(source.includes(literal), `${literal} is gone from render.ts`);
});

test('the built web app holds no Pro QR drawing code or card artwork', () => {
  assert.ok(
    existsSync(next),
    'apps/web/.next is missing: run the web build before this test',
  );
  const files = [...walk(join(next, 'static')), ...walk(join(next, 'server'))];
  const text = files
    .filter((file) => /\.(js|css|html|rsc|json|txt|map)$/.test(file))
    .map((file) => [file, readFileSync(file, 'utf8')]);
  assert.ok(text.length > 10, 'the build output looks empty');
  // A build of an older checkout would pass vacuously: it must show today's QR studio.
  assert.ok(
    text.some(([, body]) => body.includes('Use a free style instead')),
    'the web build is older than this checkout: rebuild it',
  );
  for (const [file, body] of text)
    for (const literal of DRAWING_LITERALS)
      assert.ok(!body.includes(literal), `${literal} found in ${file}`);
  // The card artwork, by name and by content: a renamed copy is still caught.
  const artDir = join(root, 'apps/api/assets/qr-cards');
  const art = readdirSync(artDir).map((name) => ({
    name,
    size: statSync(join(artDir, name)).size,
    hash: createHash('sha256')
      .update(readFileSync(join(artDir, name)))
      .digest('hex'),
  }));
  assert.ok(art.length >= 12);
  const sizes = new Set(art.map((item) => item.size));
  const hashes = new Set(art.map((item) => item.hash));
  for (const file of files) {
    for (const item of art)
      assert.ok(
        !file.endsWith(item.name),
        `card artwork ${item.name} is in the build: ${file}`,
      );
    if (!sizes.has(statSync(file).size)) continue;
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.ok(
      !hashes.has(hash),
      `card artwork bytes are in the build: ${file}`,
    );
  }
});

test('the web app and contracts never import the renderer, its modules or the card artwork', () => {
  const forbidden =
    /(apps\/api|@tipme\/api\b|qr\/render|covers-for-cards|qr\/mosaic|assets\/qr-cards|from ['"]sharp['"]|require\(['"]sharp['"]\))/;
  const sources = [
    ...walk(join(root, 'apps/web/src')),
    ...walk(join(root, 'packages/contracts/src')),
    ...walk(join(root, 'packages/ui/src')),
  ].filter((file) => /\.(ts|tsx|js|mjs|css)$/.test(file));
  assert.ok(sources.length > 50);
  for (const file of sources)
    assert.ok(
      !forbidden.test(readFileSync(file, 'utf8')),
      `${file} reaches the Pro drawing code`,
    );
  for (const manifest of ['apps/web', 'packages/contracts', 'packages/ui']) {
    const pkg = JSON.parse(
      readFileSync(join(root, manifest, 'package.json'), 'utf8'),
    );
    const names = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    });
    assert.ok(
      !names.includes('@tipme/api') && !names.includes('qrcode-art'),
      `${manifest} depends on the API`,
    );
  }
});
