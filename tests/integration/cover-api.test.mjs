import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { automaticCover } from '../../packages/contracts/dist/index.js';
import {
  coverFor,
  deleteAccount,
  mailSealing,
  movePhotosToStore,
  removeCover,
  setCover,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Page covers: a design from the catalogue, or an upload the server re-encodes to a 2240×600 WebP
// with no metadata. Same safeguards as profile photos (tests/integration/avatars.test.mjs).
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
let revalidateServer;
let revalidations = [];
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  revalidateServer = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      revalidations.push(JSON.parse(raw).handle);
      response.writeHead(200).end('{}');
    });
  });
  await new Promise((resolve) =>
    revalidateServer.listen(0, '127.0.0.1', resolve),
  );
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_AVATARS_PER_HOUR: '1000',
      WEB_REVALIDATE_URL: `http://127.0.0.1:${revalidateServer.address().port}/api/revalidate`,
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
  revalidateServer.close();
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
  fetch(`${stack.api}/v1/me/cover`, {
    method: 'PUT',
    headers: { ...browserHeaders(cookie), 'content-type': type },
    body,
  });
const chooseDesign = (cookie, body) =>
  fetch(`${stack.api}/v1/me/cover-design`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify(body),
  });
const publicPage = async (handle) =>
  (await (await fetch(`${stack.api}/v1/profiles/${handle}`)).json()).data;
const myPage = async (cookie) =>
  (
    await (
      await fetch(`${stack.api}/v1/me/profile`, {
        headers: browserHeaders(cookie),
      })
    ).json()
  ).data;

/** A real photo-like JPEG with location and camera metadata in it. */
const photo = () =>
  sharp({
    create: {
      width: 1600,
      height: 1000,
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

/** An in-memory stand-in for the R2 store (as in photo-storage.test.mjs). */
function memoryStore() {
  const objects = new Map();
  return {
    endpoint: 'memory://',
    objects,
    async put(key, webp) {
      objects.set(key, Buffer.from(webp));
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}
const fakeWebp = (label) => Buffer.from(`RIFF0000WEBPVP8 ${label}`);
const versionOf = (path) => Number(/\/(\d+)\.webp$/.exec(path)[1]);

async function userAndPage(handle) {
  const { rows } = await database.pool.query(
    'SELECT id, user_id FROM profiles WHERE handle_lower = $1',
    [handle],
  );
  return { profileId: rows[0].id, userId: rows[0].user_id };
}

test('automatic cover is stable and one of the three, and changes nothing in the database', async () => {
  const cookie = await livePage('+2348031290001', 'cover_auto');
  const expected = automaticCover('cover_auto');
  for (let i = 0; i < 2; i += 1) {
    const page = await publicPage('cover_auto');
    assert.equal(page.cover.kind, 'design');
    assert.equal(page.cover.design, expected);
  }
  assert.ok(['scattered', 'large', 'dark'].includes(expected));
  const mine = await myPage(cookie);
  assert.deepEqual(mine.cover, (await publicPage('cover_auto')).cover);
  assert.deepEqual(mine.coverChoice, {
    design: null,
    colour: null,
    hasPhoto: false,
  });
  const { rows } = await database.pool.query(
    `SELECT cover_design, cover_colour, cover_path, cover_version FROM profiles WHERE handle_lower = 'cover_auto'`,
  );
  assert.deepEqual(rows[0], {
    cover_design: null,
    cover_colour: null,
    cover_path: null,
    cover_version: 0,
  });
});

test('photo beats design beats automatic', async () => {
  const cookie = await livePage('+2348031290002', 'cover_order');
  const chosen = await chooseDesign(cookie, {
    design: 'ripple',
    colour: 'rose',
  });
  assert.equal(chosen.status, 200);
  assert.deepEqual((await chosen.json()).data.coverChoice, {
    design: 'ripple',
    colour: 'rose',
    hasPhoto: false,
  });
  assert.deepEqual((await publicPage('cover_order')).cover, {
    kind: 'design',
    design: 'ripple',
    colour: 'rose',
  });

  const uploaded = (await (await upload(cookie, await photo())).json()).data;
  assert.equal(uploaded.cover.kind, 'photo');
  assert.equal(uploaded.coverChoice.hasPhoto, true);
  assert.equal(uploaded.coverChoice.design, 'ripple', 'the choice is kept');
  assert.deepEqual((await publicPage('cover_order')).cover, uploaded.cover);

  // Removing the photo returns to the chosen design.
  const removed = await fetch(`${stack.api}/v1/me/cover`, {
    method: 'DELETE',
    headers: browserHeaders(cookie),
  });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).data.cover, {
    kind: 'design',
    design: 'ripple',
    colour: 'rose',
  });

  // Clearing the choice returns to automatic.
  const cleared = await chooseDesign(cookie, { design: null });
  assert.equal(cleared.status, 200);
  assert.equal(
    (await publicPage('cover_order')).cover.design,
    automaticCover('cover_order'),
  );
});

test('an upload is re-encoded to 2240x600 WebP with no metadata', async () => {
  const cookie = await livePage('+2348031290003', 'cover_clean');
  const original = await photo();
  assert.ok(
    original.includes(Buffer.from('SecretCam')),
    'the test photo has metadata',
  );
  const response = await upload(cookie, original);
  assert.equal(response.status, 200);
  const { cover } = (await response.json()).data;
  assert.match(cover.path, /^\/v1\/covers\/[0-9a-f-]{36}\/\d+\.webp$/);

  const served = await fetch(`${stack.api}${cover.path}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    served.headers.get('content-security-policy'),
    "default-src 'none'",
  );
  assert.match(served.headers.get('cache-control'), /max-age=3600\b/);
  assert.match(served.headers.get('cache-control'), /immutable/);
  const bytes = Buffer.from(await served.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 2240);
  assert.equal(meta.height, 600);
  assert.equal(meta.exif, undefined, 'no EXIF');
  for (const leak of ['SecretCam', 'Ada Home Address'])
    assert.equal(bytes.includes(Buffer.from(leak)), false, leak);
});

test('SVG, oversize and pixel-bomb uploads are refused', async () => {
  const cookie = await livePage('+2348031290004', 'cover_bad');
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  assert.equal((await upload(cookie, svg, 'image/svg+xml')).status, 415);
  assert.equal(
    (await upload(cookie, Buffer.from('<html>hi</html>'), 'text/html')).status,
    415,
  );
  // An SVG that says it is a JPEG is still refused: the bytes decide, not the label.
  const disguised = await upload(cookie, svg, 'image/jpeg');
  assert.equal(disguised.status, 400);
  assert.equal((await disguised.json()).error.code, 'INVALID_IMAGE');
  const garbage = await upload(cookie, Buffer.from('not really a jpeg at all'));
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).error.code, 'INVALID_IMAGE');
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
  // Nothing was stored by any of those.
  assert.equal((await myPage(cookie)).coverChoice.hasPhoto, false);
  // Signed out: refused.
  assert.equal(
    (
      await fetch(`${stack.api}/v1/me/cover`, {
        method: 'PUT',
        headers: { origin: WEB, 'content-type': 'image/jpeg' },
        body: await photo(),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${stack.api}/v1/me/cover-design`, {
        method: 'PUT',
        headers: { origin: WEB, 'content-type': 'application/json' },
        body: JSON.stringify({ design: 'danfo' }),
      })
    ).status,
    401,
  );
});

test('an unknown design or a colour on a design without colours is refused', async () => {
  const cookie = await livePage('+2348031290005', 'cover_refuse');
  for (const body of [
    { design: 'retired' },
    { design: 'large', colour: 'puce' },
    { design: 'danfo', colour: 'rose' },
    { design: 'dark', colour: 'neutral' },
    { design: null, colour: 'rose' },
    {},
  ])
    assert.equal(
      (await chooseDesign(cookie, body)).status,
      400,
      JSON.stringify(body),
    );
  assert.deepEqual((await myPage(cookie)).coverChoice, {
    design: null,
    colour: null,
    hasPhoto: false,
  });
});

test('a replaced cover URL stops working, and a hidden or deleted page serves none', async () => {
  const cookie = await livePage('+2348031290006', 'cover_gone');
  const first = (await (await upload(cookie, await photo())).json()).data.cover;
  const second = (await (await upload(cookie, await photo())).json()).data
    .cover;
  assert.ok(versionOf(second.path) > versionOf(first.path));
  assert.equal((await fetch(`${stack.api}${first.path}`)).status, 404);
  assert.equal((await fetch(`${stack.api}${second.path}`)).status, 200);

  // Not live: not served, and served again once live.
  await fetch(`${stack.api}/v1/me/page/state`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ state: 'not_live' }),
  });
  assert.equal((await fetch(`${stack.api}${second.path}`)).status, 404);
  await fetch(`${stack.api}/v1/me/page/state`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ state: 'live' }),
  });
  assert.equal((await fetch(`${stack.api}${second.path}`)).status, 200);

  // Paused by TipMe: not served.
  await database.pool.query(
    `UPDATE profiles SET status = 'suspended', suspended_reason = 'Under review' WHERE handle_lower = 'cover_gone'`,
  );
  assert.equal((await fetch(`${stack.api}${second.path}`)).status, 404);
  await database.pool.query(
    `UPDATE profiles SET status = 'active', suspended_reason = NULL WHERE handle_lower = 'cover_gone'`,
  );

  // Removed, then a new one: the number never comes back.
  await fetch(`${stack.api}/v1/me/cover`, {
    method: 'DELETE',
    headers: browserHeaders(cookie),
  });
  assert.equal((await fetch(`${stack.api}${second.path}`)).status, 404);
  const third = (await (await upload(cookie, await photo())).json()).data.cover;
  assert.ok(versionOf(third.path) > versionOf(second.path));
  assert.equal((await fetch(`${stack.api}${second.path}`)).status, 404);

  // Malformed addresses are simply not found.
  for (const path of [
    '/v1/covers/not-a-uuid/1.webp',
    `${third.path.replace('.webp', '.png')}`,
  ])
    assert.equal((await fetch(`${stack.api}${path}`)).status, 404, path);

  // Deleted: the bytes and every trace of the choice go.
  const deleted = await fetch(`${stack.api}/v1/me/account`, {
    method: 'DELETE',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  assert.equal(deleted.status, 204);
  assert.equal((await fetch(`${stack.api}${third.path}`)).status, 404);
  const profileId = third.path.split('/')[3];
  const { rows } = await database.pool.query(
    `SELECT cover_design, cover_colour, cover_path,
            (SELECT count(*)::int FROM profile_covers c WHERE c.profile_id = p.id) AS stored
       FROM profiles p WHERE p.id = $1`,
    [profileId],
  );
  assert.deepEqual(rows[0], {
    cover_design: null,
    cover_colour: null,
    cover_path: null,
    stored: 0,
  });
});

test('each change refreshes the public page', async () => {
  const cookie = await livePage('+2348031290010', 'cover_fresh');
  await new Promise((resolve) => setTimeout(resolve, 200));
  revalidations = [];
  assert.equal((await upload(cookie, await photo())).status, 200);
  assert.equal((await chooseDesign(cookie, { design: 'danfo' })).status, 200);
  const removed = await fetch(`${stack.api}/v1/me/cover`, {
    method: 'DELETE',
    headers: browserHeaders(cookie),
  });
  assert.equal(removed.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(revalidations, [
    'cover_fresh',
    'cover_fresh',
    'cover_fresh',
  ]);
});

test('with a store, a cover lives there, is replaced there and removed there', async () => {
  await livePage('+2348031290007', 'cover_store');
  const { profileId, userId } = await userAndPage('cover_store');
  const store = memoryStore();
  const one = await setCover(database.db, userId, fakeWebp('one'), store);
  const [row] = (
    await database.pool.query(
      'SELECT bytes, object_key FROM profile_covers WHERE profile_id = $1',
      [profileId],
    )
  ).rows;
  assert.equal(row.bytes, null);
  assert.match(row.object_key, /^covers\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/);
  assert.deepEqual(
    await coverFor(
      database.db,
      { profileId, version: versionOf(one.cover.path) },
      store,
    ),
    fakeWebp('one'),
  );
  await setCover(database.db, userId, fakeWebp('two'), store);
  assert.deepEqual([...store.objects.values()], [fakeWebp('two')]);
  await removeCover(database.db, userId, store);
  assert.equal(store.objects.size, 0);
});

test('deleting an account removes its stored cover, including from the object store', async () => {
  await livePage('+2348031290008', 'cover_erase');
  const { profileId, userId } = await userAndPage('cover_erase');
  const store = memoryStore();
  await setCover(database.db, userId, fakeWebp('mine'), store);
  assert.equal(store.objects.size, 1);
  await deleteAccount(database.db, {
    userId,
    sealing: mailSealing(Buffer.alloc(32, 7)),
    photos: store,
  });
  assert.equal(store.objects.size, 0, 'the object went with the account');
  const { rows } = await database.pool.query(
    'SELECT count(*)::int AS n FROM profile_covers WHERE profile_id = $1',
    [profileId],
  );
  assert.equal(rows[0].n, 0);
});

test('moving photos to the object store also moves covers', async () => {
  await livePage('+2348031290009', 'cover_move');
  const { profileId, userId } = await userAndPage('cover_move');
  const store = memoryStore();
  const mine = await setCover(database.db, userId, fakeWebp('legacy'));
  const moved = await movePhotosToStore(database.db, store);
  assert.ok(moved >= 1);
  const [row] = (
    await database.pool.query(
      'SELECT bytes, object_key FROM profile_covers WHERE profile_id = $1',
      [profileId],
    )
  ).rows;
  assert.equal(row.bytes, null);
  assert.match(row.object_key, /^covers\//);
  assert.deepEqual(store.objects.get(row.object_key), fakeWebp('legacy'));
  assert.deepEqual(
    await coverFor(
      database.db,
      { profileId, version: versionOf(mine.cover.path) },
      store,
    ),
    fakeWebp('legacy'),
  );
  assert.equal(
    await movePhotosToStore(database.db, store),
    0,
    'running it again moves nothing',
  );
});
