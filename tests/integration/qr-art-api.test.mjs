import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// The Pro QR designs and the Free lock (design spec section 7).
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const apiRequire = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const sharp = apiRequire('sharp');
const jsQR = apiRequire('jsqr');

let database;
let stack;
let limited;
let staff;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  const apiEnv = {
    WEB_ORIGIN: WEB,
    RATE_LIMIT_AUTH_PER_HOUR: '1000',
    RATE_LIMIT_AVATARS_PER_HOUR: '1000',
    RATE_LIMIT_QR_ART_PER_HOUR: '1000',
  };
  stack = await startStack({ databaseUrl: database.url, apiEnv });
  limited = await startStack({
    databaseUrl: database.url,
    apiEnv: { ...apiEnv, RATE_LIMIT_QR_ART_PER_HOUR: '3' },
  });
  staff = await opsSignIn(stack.api, database.db, '+2348031270099');
});
after(async () => {
  await limited.stop();
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function livePage(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  await call('POST', '/v1/me/page', cookie, { handle });
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  const found = await call('GET', `/v1/ops/pages/${handle}`, staff.cookie);
  const pub = (await found.json()).data;
  return { cookie, profileId: pub.profileId, handle };
}
const setPlan = (profileId, plan) =>
  call('POST', `/v1/ops/pages/${profileId}/plan`, staff.cookie, {
    plan,
    reason: 'QR designs test',
  });
const art = (cookie, file, query = '', api = stack.api) =>
  fetch(`${api}/v1/me/qr-art/${file}${query}`, {
    headers: cookie ? { cookie } : {},
  });
async function decode(response) {
  assert.equal(response.status, 200);
  const { data, info } = await sharp(Buffer.from(await response.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}
const myProfile = async (cookie) =>
  (await (await call('GET', '/v1/me/profile', cookie)).json()).data;

test('a Free page gets a marked preview that encodes the home page, never its own link', async () => {
  const page = await livePage('+2348031270001', 'free_art');
  const response = await art(page.cookie, 'heart.png', '?size=1024');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(await decode(response), `${WEB}/?src=qr-preview`);
  const catalogue = (await (await art(page.cookie, '')).json()).data;
  assert.equal(catalogue.items.length, 30);
  assert.ok(catalogue.items.every((item) => item.locked));
});

test('a Pro page gets its real link', async () => {
  const page = await livePage('+2348031270002', 'pro_art');
  assert.equal((await setPlan(page.profileId, 'pro')).status, 200);
  for (const id of ['heart', 'indigo']) {
    const response = await art(page.cookie, `${id}.png`, '?size=1024');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await decode(response), `${WEB}/@pro_art?src=qr`, id);
  }
  const catalogue = (await (await art(page.cookie, '')).json()).data;
  assert.ok(catalogue.items.every((item) => !item.locked));
});

test('a page that loses Pro gets a preview on its next request', async () => {
  const page = await livePage('+2348031270003', 'lose_art');
  await setPlan(page.profileId, 'pro');
  assert.equal(
    await decode(await art(page.cookie, 'jewel.png', '?size=1024')),
    `${WEB}/@lose_art?src=qr`,
  );
  await setPlan(page.profileId, 'free');
  assert.equal(
    await decode(await art(page.cookie, 'jewel.png', '?size=1024')),
    `${WEB}/?src=qr-preview`,
  );
});

test('a Free page cannot save a Pro design as its style; a Pro page can; leaving Pro falls back to purple on screen', async () => {
  const page = await livePage('+2348031270004', 'style_art');
  const refused = await call('PATCH', '/v1/me/profile', page.cookie, {
    qrStyle: 'heart',
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, 'QR_DESIGN_PRO_REQUIRED');
  assert.equal(
    (await call('PATCH', '/v1/me/profile', page.cookie, { qrStyle: 'night' }))
      .status,
    200,
  );
  await setPlan(page.profileId, 'pro');
  const saved = await call('PATCH', '/v1/me/profile', page.cookie, {
    qrStyle: 'heart',
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).data.qrStyle, 'heart');
  await setPlan(page.profileId, 'free');
  assert.equal((await myProfile(page.cookie)).qrStyle, 'purple');
  await setPlan(page.profileId, 'pro');
  assert.equal((await myProfile(page.cookie)).qrStyle, 'heart');
});

test('old sunset, glow and stripe values show purple, and are no longer accepted', async () => {
  const page = await livePage('+2348031270005', 'old_art');
  for (const old of ['sunset', 'glow', 'stripe']) {
    const refused = await call('PATCH', '/v1/me/profile', page.cookie, {
      qrStyle: old,
    });
    assert.equal(refused.status, 400, old);
    await database.db.execute(
      `update profiles set qr_style = '${old}' where id = '${page.profileId}'`,
    );
    assert.equal((await myProfile(page.cookie)).qrStyle, 'purple', old);
  }
});

test('another person cannot fetch your art; no session is 401', async () => {
  const a = await livePage('+2348031270006', 'owner_a');
  const b = await livePage('+2348031270007', 'owner_b');
  await setPlan(a.profileId, 'pro');
  await setPlan(b.profileId, 'pro');
  assert.equal(
    await decode(await art(b.cookie, 'heart.png', '?size=1024')),
    `${WEB}/@owner_b?src=qr`,
  );
  assert.equal((await art(undefined, 'heart.png')).status, 401);
  assert.equal((await art(undefined, '')).status, 401);
});

test('unknown ids and sizes are refused, and renders are rate limited', async () => {
  const page = await livePage('+2348031270008', 'refuse_art');
  assert.equal((await art(page.cookie, 'nope.png')).status, 404);
  assert.equal((await art(page.cookie, '..%2Fheart.png')).status, 404);
  assert.equal((await art(page.cookie, 'heart.png', '?size=999')).status, 400);
  assert.equal((await art(page.cookie, 'heart.png', '?size=5000')).status, 400);
  assert.equal((await art(page.cookie, 'heart.png', '?size=x')).status, 400);
  assert.equal(
    (await art(page.cookie, 'heart.png', '?size=1&size=2')).status,
    400,
  );
  const other = await signIn(limited.api, '+2348031270009');
  const statuses = [];
  for (let i = 0; i < 5; i++)
    statuses.push(
      (await art(other.cookie, 'heart.png', '?size=256', limited.api)).status,
    );
  assert.deepEqual(statuses.slice(3), [429, 429]);
});

test('the photo mosaic says plainly when the page has no photo, and uses it when it has', async () => {
  const page = await livePage('+2348031270010', 'mosaic_art');
  await setPlan(page.profileId, 'pro');
  const none = await art(page.cookie, 'mosaic.png', '?size=512');
  assert.equal(none.status, 409);
  const error = (await none.json()).error;
  assert.equal(error.code, 'QR_ART_PHOTO_REQUIRED');
  assert.match(error.message, /Add a photo/);
  const photo = await sharp({
    create: { width: 400, height: 400, channels: 3, background: '#c8a080' },
  })
    .jpeg()
    .toBuffer();
  const upload = await fetch(`${stack.api}/v1/me/avatar`, {
    method: 'PUT',
    headers: { ...browserHeaders(page.cookie), 'content-type': 'image/jpeg' },
    body: photo,
  });
  assert.equal(upload.status, 200);
  assert.equal(
    await decode(await art(page.cookie, 'mosaic.png', '?size=1400')),
    `${WEB}/@mosaic_art?src=qr`,
  );
});

test('the mosaic carries a plain note when a long link puts patterns on the face, and nothing is refused', async () => {
  const long = await livePage(
    '+2348031270011',
    'a_thirty_character_handle_abcd',
  );
  await setPlan(long.profileId, 'pro');
  const items = (await (await art(long.cookie, '')).json()).data.items;
  const mosaic = items.find((item) => item.id === 'mosaic');
  assert.match(mosaic.note ?? '', /long side/);
  assert.ok(
    items.filter((item) => item.id !== 'mosaic').every((i) => i.note === null),
  );
});

test('Pro art is not in any web bundle', () => {
  const root = fileURLToPath(new URL('../../apps/web/.next', import.meta.url));
  assert.ok(
    existsSync(root),
    'build the web app first: apps/web/.next is missing',
  );
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|css|html|rsc|json)$/.test(name)) files.push(path);
    }
  };
  walk(join(root, 'static'));
  walk(join(root, 'server'));
  assert.ok(files.length > 10);
  // Path data and palettes only the server's drawing code holds, and its module names.
  const markers = [
    'M.09 .86C.07',
    'M0 100V0H30C62 0 62 52',
    '#8f2746',
    'bareSvg',
    'drawMosaic',
    'PREVIEW_LETTERS',
    'qr-cards',
    'renderQrArt',
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const marker of markers)
      assert.ok(!text.includes(marker), `${marker} found in ${file}`);
  }
});
