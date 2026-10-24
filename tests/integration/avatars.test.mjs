import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Profile photos (PR-013, PRD v1.1 FR-01 "optional profile photo"). Every upload is decoded and
// re-encoded on the server: a 512×512 WebP with no metadata (no location, no camera details).
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const sharp = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('sharp');

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

async function livePage(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  await fetch(`${stack.api}/v1/me/page`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ handle }),
  });
  await fetch(`${stack.api}/v1/me/page/state`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ state: 'live' }),
  });
  return cookie;
}

const upload = (cookie, body, type = 'image/jpeg') =>
  fetch(`${stack.api}/v1/me/avatar`, {
    method: 'PUT',
    headers: { ...browserHeaders(cookie), 'content-type': type },
    body,
  });

/** A real photo-like JPEG with location and camera metadata in it. */
const photo = () =>
  sharp({
    create: {
      width: 1200,
      height: 900,
      channels: 3,
      background: { r: 122, g: 50, b: 249 },
    },
  })
    .withExif({
      IFD0: { Make: 'SecretCam', Copyright: 'Ada Home Address' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 27/1 0/1' },
    })
    .jpeg()
    .toBuffer();

test('an uploaded photo becomes a 512×512 WebP with no metadata, shown on the public page', async () => {
  const cookie = await livePage('+2348031280001', 'photo_ada');
  const original = await photo();
  assert.ok(
    original.includes(Buffer.from('SecretCam')),
    'the test photo has metadata',
  );
  const response = await upload(cookie, original);
  assert.equal(response.status, 200);
  const mine = (await response.json()).data;
  assert.match(mine.avatarPath, /^\/v1\/avatars\/[0-9a-f-]{36}\/\d+\.webp$/);

  const served = await fetch(`${stack.api}${mine.avatarPath}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('cache-control'), /immutable/);
  const bytes = Buffer.from(await served.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
  assert.equal(meta.exif, undefined, 'no EXIF');
  for (const leak of ['SecretCam', 'Ada Home Address'])
    assert.equal(bytes.includes(Buffer.from(leak)), false, leak);

  const page = (
    await (await fetch(`${stack.api}/v1/profiles/photo_ada`)).json()
  ).data;
  assert.equal(page.avatarPath, mine.avatarPath);
});

test('anything that is not a real image is refused: SVG, HTML, random bytes, a pixel bomb, an oversized file', async () => {
  const cookie = await livePage('+2348031280002', 'photo_bad');
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  assert.equal((await upload(cookie, svg, 'image/svg+xml')).status, 415);
  assert.equal(
    (await upload(cookie, Buffer.from('<html>hi</html>'), 'text/html')).status,
    415,
  );
  const garbage = await upload(cookie, Buffer.from('not really a jpeg at all'));
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).error.code, 'INVALID_IMAGE');
  // 16,000 × 16,000 pixels (256 MP, over 6× the 40 MP limit) in a small file: refused before
  // it is decoded in full.
  const bomb = await sharp({
    create: {
      width: 16000,
      height: 16000,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  assert.equal((await upload(cookie, bomb, 'image/png')).status, 400);
  const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
  assert.equal((await upload(cookie, huge)).status, 413);
  // Signed out: refused.
  assert.equal(
    (
      await fetch(`${stack.api}/v1/me/avatar`, {
        method: 'PUT',
        headers: { origin: WEB, 'content-type': 'image/jpeg' },
        body: await photo(),
      })
    ).status,
    401,
  );
});

test('a photo is not served once the page is not live, and removing it takes it down', async () => {
  const cookie = await livePage('+2348031280003', 'photo_gone');
  const mine = (await (await upload(cookie, await photo())).json()).data;
  await fetch(`${stack.api}/v1/me/page/state`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ state: 'not_live' }),
  });
  assert.equal((await fetch(`${stack.api}${mine.avatarPath}`)).status, 404);
  await fetch(`${stack.api}/v1/me/page/state`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ state: 'live' }),
  });
  assert.equal((await fetch(`${stack.api}${mine.avatarPath}`)).status, 200);

  const removed = await fetch(`${stack.api}/v1/me/avatar`, {
    method: 'DELETE',
    headers: browserHeaders(cookie),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).data.avatarPath, null);
  assert.equal((await fetch(`${stack.api}${mine.avatarPath}`)).status, 404);
});
