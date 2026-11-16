import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import {
  DESIGN_CHECK_VERSION,
  applyStudioFix,
} from '../../packages/contracts/dist/index.js';
import {
  addStudioImage,
  deleteAccount,
  discardStudioDraft,
  mailSealing,
  saveStudioDraft,
  staffRemoveStudioImage,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  WEB,
  browserHeaders,
  setSwitch,
  signIn,
  startStack,
} from './helpers.mjs';

// Page Studio storage and API (plan Task 7): drafts, the publish gate, photos and their crops,
// the public page's fallback, a Pro lapse, staff removal, and the switch. Generated images only.
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
const q = (text, values = []) =>
  database.pool.query(text, values).then((r) => r.rows);
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_AVATARS_PER_HOUR: '1000',
    },
  });
  // Page Studio is the `page_studio` admin switch (owner, 14 Nov 2026), off by default; no variable.
  await setSwitch(database.pool, 'page_studio', true);
});
after(async () => {
  await stack.stop();
  await database.close();
});

let n = 0;
/** A live page for a new person; Pro unless asked otherwise. */
async function page({ pro = true } = {}) {
  n += 1;
  const phone = `+234803${String(Date.now()).slice(-5)}${String(n).padStart(2, '0')}`;
  const handle = `studio${String(Date.now()).slice(-6)}${n}`;
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
  const [{ id }] = await q('SELECT id FROM profiles WHERE handle_lower = $1', [
    handle,
  ]);
  if (pro)
    await q(
      `UPDATE profiles SET staff_pro = true, plan = 'pro' WHERE id = $1`,
      [id],
    );
  return { cookie, handle, profileId: id };
}

const call = (cookie, method, path, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});
const studio = async (cookie) =>
  (await json(await call(cookie, 'GET', '/v1/me/studio'))).body.data;
const save = (cookie, rev, draft) =>
  call(cookie, 'PUT', '/v1/me/studio/draft', { rev, draft });
const publish = (cookie, rev) =>
  call(cookie, 'POST', '/v1/me/studio/publish', { rev });
const publicPage = async (handle) =>
  (await (await fetch(`${stack.api}/v1/profiles/${handle}`)).json()).data;

/** A generated photo: a gradient, `width` by `height`. */
const photo = (width, height) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 120, b: 200 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><rect x="10%" y="10%" width="30%" height="30%" fill="#f5c400"/></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg()
    .toBuffer();
async function uploadPhoto(cookie, width = 2000, height = 1400) {
  const response = await fetch(`${stack.api}/v1/me/studio/images`, {
    method: 'POST',
    headers: { ...browserHeaders(cookie), 'content-type': 'image/jpeg' },
    body: await photo(width, height),
  });
  const { body } = await json(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.meta.imageId;
}

const doc = (rows, extra = {}) => ({
  v: 1,
  brand: ['#1d4e89'],
  mode: 'light',
  fonts: { heading: 'fraunces', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows,
  ...extra,
});
const row = (id, cells, extra = {}) => ({
  id,
  columns: '1',
  spacing: 'm',
  background: 'page',
  cells,
  ...extra,
});
const heading = (id, text = 'Hello') => ({
  id,
  kind: 'text',
  variant: 'heading',
  level: 2,
  text,
});
const photoBlock = (id, imageId, extra = {}) => ({
  id,
  kind: 'photo',
  variant: 'wide',
  imageId,
  alt: 'A photo',
  ...extra,
});

test('a Pro page saves a failing draft, cannot publish it, fixes it and publishes', async () => {
  const { cookie, handle } = await page();
  const start = await studio(cookie);
  assert.equal(start.access, 'edit');
  assert.equal(start.rev, 0);
  // 700 wide: blurry in a full-width row (shown at up to 1,020), fine at half width (498).
  const imageId = await uploadPhoto(cookie, 700, 700);
  const draft = doc([
    row('row00001', [[heading('blk00001'), photoBlock('blk00002', imageId)]]),
  ]);
  const saved = await json(await save(cookie, 0, draft));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const s = saved.body.data;
  assert.equal(s.rev, 1);
  assert.deepEqual(
    s.check.issues.map((i) => i.rule),
    ['photo-resolution'],
  );
  const refused = await json(await publish(cookie, s.rev));
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, 'STUDIO_DESIGN_CHECK_FAILED');
  assert.deepEqual(
    refused.body.error.issues.map((i) => i.rule),
    ['photo-resolution'],
  );
  assert.equal(
    (await studio(cookie)).published,
    null,
    'the draft is kept, nothing published',
  );
  const fixed = applyStudioFix(s.draft, s.check.issues[0], 'smaller-slot');
  const s2 = (await json(await save(cookie, s.rev, fixed))).body.data;
  assert.deepEqual(s2.check.issues, []);
  const done = await json(await publish(cookie, s2.rev));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.data.published, fixed);
  const visible = await publicPage(handle);
  assert.deepEqual(visible.studio.document, fixed);
  assert.equal(visible.studio.checkVersion, DESIGN_CHECK_VERSION);
  const image = visible.studio.images[imageId];
  assert.match(
    image.path,
    new RegExp(`^/v1/studio-images/[0-9a-f-]{36}/${imageId}/\\d+$`),
  );
  const file = await fetch(`${stack.api}${image.path}/wide-480`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/webp');
  assert.equal(
    (await sharp(Buffer.from(await file.arrayBuffer())).metadata()).width,
    480,
  );
});

test("the server's issues win over the client's", async () => {
  const { cookie } = await page();
  // The client sees an ordinary YouTube link; the server's check (pretend outside production)
  // says this video is gone, so publishing is refused with the server's issue.
  const draft = doc([
    row('row00001', [
      [
        heading('blk00001'),
        {
          id: 'blk00002',
          kind: 'video',
          variant: 'still',
          url: 'https://youtu.be/goneGONE123',
        },
      ],
    ]),
  ]);
  const s = (await json(await save(cookie, 0, draft))).body.data;
  const refused = await json(await publish(cookie, s.rev));
  assert.equal(refused.status, 422);
  assert.deepEqual(
    refused.body.error.issues.map((i) => i.rule),
    ['broken-video'],
  );
  assert.deepEqual(
    (
      await q('SELECT status FROM studio_video_checks WHERE url = $1', [
        'https://youtu.be/goneGONE123',
      ])
    ).map((r) => r.status),
    ['gone'],
  );
});

test('a published page that fails a newer check falls back to the standard page', async () => {
  const { cookie, handle, profileId } = await page();
  const draft = doc([row('row00001', [[heading('blk00001')]])]);
  const s = (await json(await save(cookie, 0, draft))).body.data;
  assert.equal((await publish(cookie, s.rev)).status, 200);
  assert.ok((await publicPage(handle)).studio);
  // As if a rule changed: the stored version now has an empty block.
  await q(
    `UPDATE page_studios SET published = jsonb_set(published, '{rows,0,cells,0}', '[{"id":"blk00009","kind":"text","variant":"heading","level":2,"text":""}]') WHERE profile_id = $1`,
    [profileId],
  );
  const after = await publicPage(handle);
  assert.equal(after.studio, undefined, 'the standard page shows');
  assert.equal(after.handle, handle);
});

test('a save with an old rev is refused and keeps the newer draft', async () => {
  const { cookie } = await page();
  const first = doc([row('row00001', [[heading('blk00001', 'First')]])]);
  const second = doc([row('row00001', [[heading('blk00001', 'Second')]])]);
  assert.equal((await save(cookie, 0, first)).status, 200);
  const stale = await json(await save(cookie, 0, second));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STUDIO_DRAFT_STALE');
  assert.equal((await studio(cookie)).draft.rows[0].cells[0][0].text, 'First');
});

test('a Free page cannot save; its preview is never stored', async () => {
  const { cookie, profileId } = await page({ pro: false });
  const s = await studio(cookie);
  assert.equal(s.access, 'preview');
  assert.equal(s.rev, 0);
  const refused = await json(await save(cookie, 0, s.draft));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'STUDIO_PRO_REQUIRED');
  assert.equal((await publish(cookie, 0)).status, 403);
  assert.deepEqual(
    await q('SELECT 1 FROM page_studios WHERE profile_id = $1', [profileId]),
    [],
  );
});

test('publish after Pro ended is refused and the draft is kept', async () => {
  const { cookie, handle, profileId } = await page();
  const draft = doc([row('row00001', [[heading('blk00001')]])]);
  const s = (await json(await save(cookie, 0, draft))).body.data;
  assert.equal((await publish(cookie, s.rev)).status, 200);
  const edited = doc([row('row00001', [[heading('blk00001', 'Edited')]])]);
  const s2 = (await json(await save(cookie, s.rev, edited))).body.data;
  await q(
    `UPDATE profiles SET staff_pro = false, plan = 'free' WHERE id = $1`,
    [profileId],
  );
  const refused = await json(await publish(cookie, s2.rev));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'STUDIO_PRO_REQUIRED');
  const kept = await studio(cookie);
  assert.equal(kept.access, 'lapsed');
  assert.deepEqual(kept.draft, edited);
  assert.equal(
    (await publicPage(handle)).studio,
    undefined,
    'the standard page shows while lapsed',
  );
  await q(`UPDATE profiles SET staff_pro = true, plan = 'pro' WHERE id = $1`, [
    profileId,
  ]);
  assert.deepEqual(
    (await publicPage(handle)).studio.document,
    draft,
    'Pro again: the same page is back',
  );
});

test("another page's image id is refused in a draft", async () => {
  const other = await page();
  const theirs = await uploadPhoto(other.cookie);
  const { cookie } = await page();
  const refused = await json(
    await save(
      cookie,
      0,
      doc([
        row('row00001', [
          [heading('blk00001'), photoBlock('blk00002', theirs)],
        ]),
      ]),
    ),
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'VALIDATION_FAILED');
});

test('discard and publish remove unreferenced images only', async () => {
  const { cookie, profileId } = await page();
  const kept = await uploadPhoto(cookie);
  const dropped = await uploadPhoto(cookie);
  const neverUsed = await uploadPhoto(cookie);
  const both = doc([
    row(
      'row00001',
      [
        [heading('blk00001'), photoBlock('blk00002', kept)],
        [photoBlock('blk00003', dropped)],
      ],
      { columns: '1-1' },
    ),
  ]);
  const s = (await json(await save(cookie, 0, both))).body.data;
  assert.equal(s.images.length, 3, 'saving keeps every uploaded photo');
  const one = doc([
    row('row00001', [[heading('blk00001'), photoBlock('blk00002', kept)], []], {
      columns: '1-1',
    }),
  ]);
  const s2 = (await json(await save(cookie, s.rev, one))).body.data;
  assert.equal((await publish(cookie, s2.rev)).status, 200);
  const ids = async () =>
    (
      await q(
        'SELECT id FROM studio_images WHERE profile_id = $1 ORDER BY id',
        [profileId],
      )
    ).map((r) => r.id);
  assert.deepEqual(
    await ids(),
    [kept].sort(),
    'publishing removes what neither version uses',
  );
  // A new photo in the draft, then Discard: back to the published page, and the new photo goes.
  const extra = await uploadPhoto(cookie);
  const s3 = await studio(cookie);
  const withExtra = doc([
    row(
      'row00001',
      [
        [heading('blk00001'), photoBlock('blk00002', kept)],
        [photoBlock('blk00004', extra)],
      ],
      { columns: '1-1' },
    ),
  ]);
  await save(cookie, s3.rev, withExtra);
  const discarded = (
    await json(await call(cookie, 'DELETE', '/v1/me/studio/draft'))
  ).body.data;
  assert.deepEqual(discarded.draft, one);
  assert.deepEqual(await ids(), [kept]);
  assert.ok(!(await ids()).includes(neverUsed));
});

test('photos: owners see their drafts; the public sees only what a live Pro page publishes', async () => {
  const { cookie, handle, profileId } = await page();
  const imageId = await uploadPhoto(cookie);
  const s = await studio(cookie);
  const image = s.images.find((i) => i.imageId === imageId);
  assert.deepEqual(
    [image.width, image.height, image.focalX, image.focalY],
    [2000, 1400, 50, 50],
  );
  const own = await fetch(`${stack.api}${image.path}/square-960`, {
    headers: browserHeaders(cookie),
  });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('cache-control'), 'private, no-store');
  const publicPath = `/v1/studio-images/${profileId}/${imageId}/1/square-960`;
  assert.equal(
    (await fetch(`${stack.api}${publicPath}`)).status,
    404,
    'not published yet',
  );
  const draft = doc([
    row(
      'row00001',
      [
        [
          heading('blk00001'),
          photoBlock('blk00002', imageId, { variant: 'square' }),
        ],
        [],
      ],
      { columns: '1-1' },
    ),
  ]);
  const saved = (await json(await save(cookie, s.rev, draft))).body.data;
  assert.equal(
    (await publish(cookie, saved.rev)).status,
    200,
    JSON.stringify(saved.check.issues),
  );
  assert.equal((await fetch(`${stack.api}${publicPath}`)).status, 200);
  assert.equal(
    (
      await fetch(
        `${stack.api}/v1/studio-images/${profileId}/${imageId}/1/master`,
      )
    ).status,
    404,
    'the master is never served',
  );
  // Moving the focal point makes a new version: a new address, the old one gone.
  const moved = await json(
    await call(cookie, 'PUT', `/v1/me/studio/images/${imageId}/focus`, {
      focalX: 90,
      focalY: 10,
    }),
  );
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const after = moved.body.data.images.find((i) => i.imageId === imageId);
  assert.deepEqual([after.focalX, after.focalY], [90, 10]);
  assert.equal((await fetch(`${stack.api}${publicPath}`)).status, 404);
  assert.equal(
    (
      await fetch(
        `${stack.api}/v1/studio-images/${profileId}/${imageId}/2/square-960`,
      )
    ).status,
    200,
  );
  assert.match((await publicPage(handle)).studio.images[imageId].path, /\/2$/);
  // A photo under 600px on its short side is refused plainly.
  const small = await fetch(`${stack.api}/v1/me/studio/images`, {
    method: 'POST',
    headers: { ...browserHeaders(cookie), 'content-type': 'image/jpeg' },
    body: await photo(1200, 500),
  });
  assert.equal(small.status, 422);
  assert.equal((await small.json()).error.code, 'IMAGE_TOO_SMALL');
});

test('staff can remove one Studio photo; it drops out of both versions; audited', async () => {
  const { cookie, profileId } = await page();
  const imageId = await uploadPhoto(cookie);
  const draft = doc([
    row(
      'row00001',
      [
        [
          heading('blk00001'),
          photoBlock('blk00002', imageId, { variant: 'square' }),
        ],
        [],
      ],
      { columns: '1-1' },
    ),
  ]);
  const s = (await json(await save(cookie, 0, draft))).body.data;
  assert.equal((await publish(cookie, s.rev)).status, 200);
  const [staff] = await q(`SELECT id FROM users LIMIT 1`);
  const result = await staffRemoveStudioImage(database.db, {
    staffUserId: staff.id,
    profileId,
    imageId,
    reason: 'Reported photo',
    sealing: mailSealing(Buffer.alloc(32, 7)),
  });
  assert.equal(result.changed, true);
  const after = await studio(cookie);
  for (const version of [after.draft, after.published])
    assert.ok(
      !JSON.stringify(version).includes(imageId),
      'gone from the draft and the published version',
    );
  assert.deepEqual(
    await q('SELECT 1 FROM studio_images WHERE id = $1', [imageId]),
    [],
  );
  const audits = await q(
    `SELECT action, reason FROM audit_events WHERE subject_id = $1 AND action = 'page.studio_photo_removed'`,
    [profileId],
  );
  assert.deepEqual(audits, [
    { action: 'page.studio_photo_removed', reason: 'Reported photo' },
  ]);
  const again = await staffRemoveStudioImage(database.db, {
    staffUserId: staff.id,
    profileId,
    imageId,
    reason: 'Again',
    sealing: mailSealing(Buffer.alloc(32, 7)),
  });
  assert.equal(again.changed, false);
});

test('every Studio route is 404 while the page_studio switch is off, and back at once when on', async () => {
  const { cookie, handle } = await page();
  const draft = doc([row('row00001', [[heading('blk00001')]])]);
  const saved = (await json(await save(cookie, 0, draft))).body.data;
  assert.equal((await publish(cookie, saved.rev)).status, 200);
  assert.ok((await publicPage(handle)).studio);
  const at = (method, path, body) =>
    fetch(`${stack.api}${path}`, {
      method,
      headers: browserHeaders(cookie),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  await setSwitch(database.pool, 'page_studio', false);
  try {
    for (const [method, path, body] of [
      ['GET', '/v1/me/studio'],
      ['PUT', '/v1/me/studio/draft', { rev: 0, draft: doc([]) }],
      ['POST', '/v1/me/studio/publish', { rev: 0 }],
      ['DELETE', '/v1/me/studio/draft'],
      ['POST', '/v1/me/studio/images'],
      [
        'PUT',
        '/v1/me/studio/images/00000000-0000-4000-8000-000000000000/focus',
        { focalX: 1, focalY: 1 },
      ],
      [
        'GET',
        '/v1/me/studio-images/00000000-0000-4000-8000-000000000000/1/square-480',
      ],
      [
        'GET',
        '/v1/studio-images/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000/1/square-480',
      ],
    ])
      assert.equal(
        (await at(method, path, body)).status,
        404,
        `${method} ${path}`,
      );
    // The published design waits; the standard page shows.
    const off = await publicPage(handle);
    assert.equal(off.handle, handle);
    assert.equal(off.studio, undefined);
  } finally {
    await setSwitch(database.pool, 'page_studio', true);
  }
  // Staff turning it on takes effect without a restart.
  assert.equal((await at('GET', '/v1/me/studio')).status, 200);
  assert.ok((await publicPage(handle)).studio);
});

/** An in-memory stand-in for the R2 store (as in cover-api.test.mjs). */
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

test('with an object store, photo files live there and leave with the photo', async () => {
  const { cookie, profileId } = await page();
  const [{ user_id: userId }] = await q(
    'SELECT user_id FROM profiles WHERE id = $1',
    [profileId],
  );
  const store = memoryStore();
  const files = {
    master: Buffer.from('m'),
    'square-480': Buffer.from('s'),
    'wide-480': Buffer.from('w'),
  };
  const { imageId } = await addStudioImage(
    database.db,
    userId,
    { width: 2000, height: 1400, files },
    store,
  );
  assert.equal(store.objects.size, 3);
  const keys = await q(
    'SELECT name, object_key, bytes FROM studio_image_files WHERE image_id = $1 ORDER BY name',
    [imageId],
  );
  assert.ok(
    keys.every((k) => k.object_key && k.bytes === null),
    'in the store, not in Postgres',
  );
  assert.ok(
    keys.every((k) =>
      /^studio\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/.test(k.object_key),
    ),
    'opaque keys only',
  );
  await saveStudioDraft(database.db, userId, {
    rev: 0,
    draft: doc([row('row00001', [[heading('blk00001')]])]),
  });
  await discardStudioDraft(database.db, userId, store);
  assert.equal(
    store.objects.size,
    0,
    'the unused photo and its objects are gone',
  );
  assert.ok(cookie);
});

test('deleting the account deletes its Studio designs and photos', async () => {
  const { cookie, profileId } = await page();
  const imageId = await uploadPhoto(cookie);
  const draft = doc([
    row(
      'row00001',
      [
        [
          heading('blk00001'),
          photoBlock('blk00002', imageId, { variant: 'square' }),
        ],
        [],
      ],
      { columns: '1-1' },
    ),
  ]);
  const s = (await json(await save(cookie, 0, draft))).body.data;
  assert.equal((await publish(cookie, s.rev)).status, 200);
  const [{ user_id: userId }] = await q(
    'SELECT user_id FROM profiles WHERE id = $1',
    [profileId],
  );
  await deleteAccount(database.db, {
    userId,
    sealing: mailSealing(Buffer.alloc(32, 7)),
  });
  assert.deepEqual(
    await q('SELECT 1 FROM page_studios WHERE profile_id = $1', [profileId]),
    [],
  );
  assert.deepEqual(
    await q('SELECT 1 FROM studio_images WHERE profile_id = $1', [profileId]),
    [],
  );
  assert.deepEqual(
    await q('SELECT 1 FROM studio_image_files WHERE image_id = $1', [imageId]),
    [],
  );
});
