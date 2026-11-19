import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import {
  DESIGN_CHECK_VERSION,
  photoAccentNotice,
  resolveStudio,
  studioTokens,
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
import { StudioPhotoAccent } from '../../apps/api/dist/studio/photo-accent.js';
import {
  REDIS_URL,
  Redis,
  WEB,
  browserHeaders,
  openEventStream,
  setSwitch,
  signIn,
  startStack,
} from './helpers.mjs';

// Page Studio storage and API (plan Task 7; styles plan Tasks 10 and 12): v2 drafts (a v1 one is refused), the
// publish gate, Free and Pro (§11, §14.6), photos and their crops, the public page's fallback and
// lapse rules (§12.5), staff removal, and the switch. Generated images only.
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
/** Each web revalidation, with the page's stored photo accent when it arrived. */
const revalidations = [];
const q = (text, values = []) =>
  database.pool.query(text, values).then((r) => r.rows);
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  revalidateServer = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', async () => {
      const body = JSON.parse(raw);
      const [studio] = await q(
        `SELECT s.photo_accent FROM page_studios s JOIN profiles p ON p.id = s.profile_id
          WHERE p.handle_lower = $1`,
        [body.handle ?? ''],
      ).catch(() => []);
      revalidations.push({
        handle: body.handle,
        photoAccent: studio?.photo_accent ?? null,
      });
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
      LIVE_UPDATES_ENABLED: 'true',
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
      WEB_REVALIDATE_URL: `http://127.0.0.1:${revalidateServer.address().port}/api/revalidate`,
    },
  });
  // Page Studio is the `page_studio` admin switch (owner, 14 Nov 2026), off by default; no variable.
  await setSwitch(database.pool, 'page_studio', true);
});
after(async () => {
  await stack.stop();
  await database.close();
  revalidateServer.close();
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
/** The old editor's v1 document: refused since the editor moved to v2 (ruling R1, PR 4a). */
const V1_DRAFT = doc([row('row00001', [[heading('blk00001')]])]);

// The v2 document (styles spec §5.2): a style, an accent, a mode, a cover and blocks in order.
const v2 = (extra = {}) => ({
  v: 2,
  style: 'clear',
  accent: null,
  mode: 'light',
  cover: 'yours',
  blocks: [
    { id: 'blk00001', kind: 'text', variant: 'heading', text: 'New single' },
    { id: 'blk00002', kind: 'quote', text: 'Sang like home.' },
  ],
  ...extra,
});
const title = (id, text = 'New single') => ({
  id,
  kind: 'text',
  variant: 'heading',
  text,
});
const photoBlock = (id, imageId, extra = {}) => ({
  id,
  kind: 'photo',
  imageId,
  alt: 'A photo',
  ...extra,
});
/** A v2 draft with these blocks (Clear unless asked otherwise). */
const withBlocks = (blocks, extra = {}) => v2({ blocks, ...extra });
const galleryOf = (id, imageIds, alt = 'On stage') => ({
  id,
  kind: 'gallery',
  images: imageIds.map((imageId) => ({ imageId, alt })),
});
/** No events in these documents, so any date resolves them the same as the server's today. */
const asStored = (d) => resolveStudio(d, '2000-01-01');
const setPlan = (profileId, plan) =>
  q(`UPDATE profiles SET staff_pro = $2, plan = $3 WHERE id = $1`, [
    profileId,
    plan === 'pro',
    plan,
  ]);
const stored = async (profileId) =>
  (
    await q(
      'SELECT draft, published, published_check_version FROM page_studios WHERE profile_id = $1',
      [profileId],
    )
  )[0];

test('a page saves a failing draft, cannot publish it, changes it and publishes', async () => {
  const { cookie, handle } = await page();
  const start = await studio(cookie);
  assert.equal(start.access, 'edit');
  assert.equal(start.rev, 0);
  // 600 wide: blurry in Journal's photo column (604 at 1440), fine in Clear's (440).
  const imageId = await uploadPhoto(cookie, 600, 600);
  const draft = v2({
    style: 'journal',
    blocks: [
      title('blk00001'),
      { id: 'blk00002', kind: 'photo', imageId, alt: 'A photo' },
    ],
  });
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
  const fixed = { ...draft, style: 'clear' };
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
  const draft = withBlocks([
    title('blk00001'),
    { id: 'blk00002', kind: 'video', url: 'https://youtu.be/goneGONE123' },
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
  const draft = withBlocks([title('blk00001')]);
  const s = (await json(await save(cookie, 0, draft))).body.data;
  assert.equal((await publish(cookie, s.rev)).status, 200);
  assert.ok((await publicPage(handle)).studio);
  // As if a rule changed: the stored version now has an empty block.
  await q(
    `UPDATE page_studios SET published = jsonb_set(published, '{blocks,0}', '{"id":"blk00009","kind":"text","variant":"heading","text":""}') WHERE profile_id = $1`,
    [profileId],
  );
  const after = await publicPage(handle);
  assert.equal(after.studio, undefined, 'the standard page shows');
  assert.equal(after.handle, handle);
});

test('a save with an old rev is refused and keeps the newer draft', async () => {
  const { cookie } = await page();
  const first = withBlocks([title('blk00001', 'First')]);
  const second = withBlocks([title('blk00001', 'Second')]);
  assert.equal((await save(cookie, 0, first)).status, 200);
  const stale = await json(await save(cookie, 0, second));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STUDIO_DRAFT_STALE');
  assert.equal((await studio(cookie)).draft.blocks[0].text, 'First');
});

test('a v1 draft is refused now that the editor speaks v2', async () => {
  for (const pro of [true, false]) {
    const { cookie, profileId } = await page({ pro });
    const refused = await json(await save(cookie, 0, V1_DRAFT));
    assert.equal(refused.status, 400, `pro: ${pro}`);
    assert.equal(refused.body.error.code, 'VALIDATION_FAILED');
    // The database refuses it too, whatever reaches it (as STUDIO_DRAFT_INVALID).
    const [{ user_id: userId }] = await q(
      'SELECT user_id FROM profiles WHERE id = $1',
      [profileId],
    );
    await assert.rejects(
      saveStudioDraft(database.db, userId, { rev: 0, draft: V1_DRAFT }),
      (error) => error.code === 'STUDIO_DRAFT_INVALID',
    );
    assert.deepEqual(
      await q('SELECT 1 FROM page_studios WHERE profile_id = $1', [profileId]),
      [],
      'nothing stored',
    );
  }
});

test('every page edits in v2: Free and Pro get access "edit" and a v2 Classic draft', async () => {
  for (const pro of [true, false]) {
    const { cookie } = await page({ pro });
    const s = await studio(cookie);
    assert.equal(s.access, 'edit');
    assert.equal(s.plan, pro ? 'pro' : 'free');
    assert.equal(s.rev, 0);
    assert.deepEqual(s.draft, {
      v: 2,
      style: 'classic',
      accent: null,
      mode: 'light',
      cover: 'yours',
      blocks: [],
    });
    assert.equal(s.check.version, DESIGN_CHECK_VERSION);
    assert.equal(s.context.plan, pro ? 'pro' : 'free');
  }
});

test('a draft the old editor stored as v1 reads as v2 and publishes', async () => {
  const { cookie, profileId } = await page();
  await q(
    `INSERT INTO page_studios (profile_id, draft, rev) VALUES ($1, $2, 1)`,
    [profileId, JSON.stringify(V1_DRAFT)],
  );
  const s = await studio(cookie);
  assert.equal(s.draft.v, 2);
  // Fraunces headings are Journal (§7.1).
  assert.equal(s.draft.style, 'journal');
  assert.deepEqual(s.draft, asStored(V1_DRAFT));
  assert.equal(s.check.version, DESIGN_CHECK_VERSION);
  const done = await json(await publish(cookie, s.rev));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.data.published, s.draft);
  const kept = await stored(profileId);
  assert.equal(kept.published.v, 2);
  assert.equal(kept.published_check_version, 3);
  // Saving it again, as the editor does, stores v2.
  const resaved = await json(await save(cookie, done.body.data.rev, s.draft));
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  assert.equal((await stored(profileId)).draft.v, 2);
});

test('Free publishes Clear', async () => {
  const { cookie, handle, profileId } = await page({ pro: false });
  const design = v2({ accent: 'blue', mode: 'auto' });
  const saved = await json(await save(cookie, 0, design));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data.draft, design);
  assert.equal(saved.body.data.check.version, 3);
  assert.deepEqual(saved.body.data.check.issues, []);
  const done = await json(await publish(cookie, saved.body.data.rev));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.data.published, design);
  assert.equal((await stored(profileId)).published_check_version, 3);
  const visible = (await publicPage(handle)).studio;
  assert.deepEqual(visible.document, design);
  assert.deepEqual(visible.palette, studioTokens('clear', 'blue'));
  assert.equal(visible.checkVersion, 3);
  assert.deepEqual(visible.images, {});
});

test("Free can't publish Stage (422 pro-only)", async () => {
  const { cookie, handle, profileId } = await page();
  const s = (await json(await save(cookie, 0, v2({ style: 'stage' })))).body
    .data;
  await setPlan(profileId, 'free');
  const refused = await json(await publish(cookie, s.rev));
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, 'STUDIO_DESIGN_CHECK_FAILED');
  assert.deepEqual(
    refused.body.error.issues.map((i) => i.rule),
    ['pro-only'],
  );
  assert.equal((await stored(profileId)).published, null);
  assert.equal((await publicPage(handle)).studio, undefined);
  assert.deepEqual((await studio(cookie)).draft, v2({ style: 'stage' }));
});

test("Free can't add a gallery block or switch to a Pro style (403)", async () => {
  const { cookie, profileId } = await page({ pro: false });
  const s = (await json(await save(cookie, 0, v2()))).body.data;
  for (const next of [
    v2({ blocks: [...v2().blocks, galleryOf('blk00003', [])] }),
    v2({ style: 'stage' }),
    v2({ style: 'tiles' }),
    v2({ accent: 'photo' }),
  ]) {
    const refused = await json(await save(cookie, s.rev, next));
    assert.equal(refused.status, 403, JSON.stringify(next).slice(0, 80));
    assert.equal(refused.body.error.code, 'STUDIO_PRO_REQUIRED');
  }
  assert.deepEqual((await stored(profileId)).draft, v2());
  // The free styles and blocks save.
  const free = v2({ style: 'linen', accent: 'green', mode: 'dark' });
  assert.equal((await save(cookie, s.rev, free)).status, 200);
});

test("Free can't upload a photo or change a focus (403)", async () => {
  const { cookie, profileId } = await page();
  const imageId = await uploadPhoto(cookie);
  await setPlan(profileId, 'free');
  const upload = await fetch(`${stack.api}/v1/me/studio/images`, {
    method: 'POST',
    headers: { ...browserHeaders(cookie), 'content-type': 'image/jpeg' },
    body: await photo(2000, 1400),
  });
  assert.equal(upload.status, 403);
  assert.equal((await upload.json()).error.code, 'STUDIO_PRO_REQUIRED');
  const focus = await json(
    await call(cookie, 'PUT', `/v1/me/studio/images/${imageId}/focus`, {
      focalX: 20,
      focalY: 20,
    }),
  );
  assert.equal(focus.status, 403);
  assert.equal(focus.body.error.code, 'STUDIO_PRO_REQUIRED');
  assert.deepEqual(
    (
      await q(
        'SELECT count(*)::int AS n FROM studio_images WHERE profile_id = $1',
        [profileId],
      )
    )[0].n,
    1,
  );
});

test('a lapsed Free draft that holds a Pro style and Pro blocks can still be reordered, have its text edited, and be discarded', async () => {
  const { cookie, profileId } = await page();
  const one = await uploadPhoto(cookie);
  const two = await uploadPhoto(cookie);
  const design = v2({
    style: 'stage',
    mode: 'dark',
    blocks: [title('blk00001'), galleryOf('blk00002', [one, two])],
  });
  const s = (await json(await save(cookie, 0, design))).body.data;
  const published = await json(await publish(cookie, s.rev));
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const lapsedDraft = v2({
    ...design,
    blocks: [...design.blocks, title('blk00003', 'Tour dates soon')],
  });
  let rev = (
    await json(await save(cookie, published.body.data.rev, lapsedDraft))
  ).body.data.rev;
  await setPlan(profileId, 'free');
  const ok = async (next, why) => {
    const r = await json(await save(cookie, rev, next));
    assert.equal(r.status, 200, `${why}: ${JSON.stringify(r.body)}`);
    rev = r.body.data.rev;
    assert.deepEqual(r.body.data.draft, next, why);
  };
  // Reorder; edit text, in the gallery too; remove a block; undo the removal.
  await ok(
    { ...lapsedDraft, blocks: [...lapsedDraft.blocks].reverse() },
    'reorder',
  );
  const edited = {
    ...lapsedDraft,
    blocks: [
      title('blk00001', 'Edited'),
      galleryOf('blk00002', [two, one], 'Edited description'),
      title('blk00003', 'Tour dates in March'),
    ],
  };
  await ok(edited, 'edit text');
  await ok({ ...edited, blocks: [edited.blocks[0]] }, 'remove');
  await ok(edited, 'undo the removal: the published version holds the gallery');
  // Adding anything Pro is refused; everything already saved stays.
  for (const next of [
    { ...edited, blocks: [...edited.blocks, galleryOf('blk00004', [one])] },
    { ...edited, style: 'horizon' },
  ]) {
    const refused = await json(await save(cookie, rev, next));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'STUDIO_PRO_REQUIRED');
  }
  assert.deepEqual((await stored(profileId)).draft, edited);
  // Discard: back to the published version; both photos are kept (it uses them).
  const discarded = await json(
    await call(cookie, 'DELETE', '/v1/me/studio/draft'),
  );
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.deepEqual(discarded.body.data.draft, design);
  assert.deepEqual(discarded.body.data.published, design);
  assert.equal(
    (
      await q(
        'SELECT count(*)::int AS n FROM studio_images WHERE profile_id = $1',
        [profileId],
      )
    )[0].n,
    2,
  );
});

test('a lapsed Pro style shows Classic', async () => {
  const { cookie, handle, profileId } = await page();
  const imageId = await uploadPhoto(cookie);
  const design = v2({
    style: 'signboard',
    accent: 'coral',
    mode: 'dark',
    cover: 'plain',
    blocks: [
      title('blk00001'),
      galleryOf('blk00002', [imageId]),
      { id: 'blk00003', kind: 'quote', text: 'Sang like home.' },
    ],
  });
  const s = (await json(await save(cookie, 0, design))).body.data;
  assert.equal((await publish(cookie, s.rev)).status, 200);
  assert.deepEqual((await publicPage(handle)).studio.document, design);
  const file = `${stack.api}/v1/studio-images/${profileId}/${imageId}/1/square-480`;
  assert.equal((await fetch(file)).status, 200);
  await setPlan(profileId, 'free');
  const shown = (await publicPage(handle)).studio;
  // Classic with their accent, mode and cover, and their text and quote blocks in order.
  assert.deepEqual(shown.document, {
    v: 2,
    style: 'classic',
    accent: 'coral',
    mode: 'dark',
    cover: 'plain',
    blocks: [design.blocks[0], design.blocks[2]],
  });
  assert.deepEqual(shown.palette, studioTokens('classic', 'coral'));
  assert.deepEqual(shown.images, {}, 'hidden photos are not listed');
  // Nothing is deleted: the design is kept as published.
  assert.deepEqual((await stored(profileId)).published, design);
  assert.equal((await fetch(file)).status, 404, 'nor served');
});

test('a lapsed free style keeps its style and drops the photo accent and Pro blocks', async () => {
  const { cookie, handle, profileId } = await page();
  const imageId = await uploadPhoto(cookie);
  const design = v2({
    style: 'journal',
    accent: 'photo',
    blocks: [title('blk00001'), galleryOf('blk00002', [imageId])],
  });
  const s = (await json(await save(cookie, 0, design))).body.data;
  const done = await json(await publish(cookie, s.rev));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok((await publicPage(handle)).studio.images[imageId]);
  await setPlan(profileId, 'free');
  const shown = (await publicPage(handle)).studio;
  assert.deepEqual(shown.document, {
    ...design,
    accent: null,
    blocks: [design.blocks[0]],
  });
  assert.deepEqual(shown.palette, studioTokens('journal', null));
  assert.deepEqual(shown.images, {});
});

test('resumed Pro shows the design again', async () => {
  const { cookie, handle, profileId } = await page();
  const design = v2({ style: 'horizon', accent: 'violet' });
  const s = (await json(await save(cookie, 0, design))).body.data;
  assert.equal((await publish(cookie, s.rev)).status, 200);
  await setPlan(profileId, 'free');
  assert.equal((await publicPage(handle)).studio.document.style, 'classic');
  await setPlan(profileId, 'pro');
  const back = (await publicPage(handle)).studio;
  assert.deepEqual(back.document, design);
  assert.deepEqual(back.palette, studioTokens('horizon', 'violet'));
});

test('a plan change during publish cannot put a Pro style live', async () => {
  const { cookie, handle, profileId } = await page();
  const s = (await json(await save(cookie, 0, v2({ style: 'sprint' })))).body
    .data;
  // Review Focus 2, with the lock-order pattern (ops-people.test.mjs whileHolding): hold the
  // page row the way a plan change does, start the publish, and move the page to Free in that
  // same transaction while the publish waits behind it.
  const held = await database.pool.connect();
  let running;
  try {
    await held.query('BEGIN');
    await held.query('SELECT 1 FROM profiles WHERE id = $1 FOR UPDATE', [
      profileId,
    ]);
    const {
      rows: [{ pid }],
    } = await held.query('SELECT pg_backend_pid() AS pid');
    running = publish(cookie, s.rev).then(json);
    let parked = false;
    for (let i = 0; i < 200 && !parked; i++) {
      parked =
        (
          await q(
            `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          )
        ).length > 0;
      if (!parked) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(parked, 'the publish waits for the page row');
    await held.query(
      `UPDATE profiles SET staff_pro = false, plan = 'free' WHERE id = $1`,
      [profileId],
    );
    await held.query('COMMIT');
  } catch (error) {
    await held.query('ROLLBACK');
    throw error;
  } finally {
    held.release();
  }
  const refused = await running;
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'STUDIO_DESIGN_CHECK_FAILED');
  assert.deepEqual(
    refused.body.error.issues.map((i) => i.rule),
    ['pro-only'],
  );
  assert.equal(
    (await stored(profileId)).published,
    null,
    'published unchanged',
  );
  assert.equal((await publicPage(handle)).studio, undefined);
});

test("another page's image id is refused in a draft", async () => {
  const other = await page();
  const theirs = await uploadPhoto(other.cookie);
  const { cookie } = await page();
  const refused = await json(
    await save(
      cookie,
      0,
      withBlocks([title('blk00001'), photoBlock('blk00002', theirs)]),
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
  const both = withBlocks([
    title('blk00001'),
    photoBlock('blk00002', kept),
    photoBlock('blk00003', dropped),
  ]);
  const s = (await json(await save(cookie, 0, both))).body.data;
  assert.equal(s.images.length, 3, 'saving keeps every uploaded photo');
  const one = withBlocks([title('blk00001'), photoBlock('blk00002', kept)]);
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
  const withExtra = withBlocks([
    title('blk00001'),
    photoBlock('blk00002', kept),
    photoBlock('blk00004', extra),
  ]);
  await save(cookie, s3.rev, withExtra);
  const discarded = (
    await json(await call(cookie, 'DELETE', '/v1/me/studio/draft'))
  ).body.data;
  // The draft is the published version again.
  assert.deepEqual(discarded.draft, asStored(one));
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
  const draft = withBlocks([
    title('blk00001'),
    photoBlock('blk00002', imageId),
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
  const draft = withBlocks([
    title('blk00001'),
    photoBlock('blk00002', imageId),
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
  const draft = withBlocks([title('blk00001')]);
  const saved = (await json(await save(cookie, 0, draft))).body.data;
  assert.equal((await publish(cookie, saved.rev)).status, 200);
  assert.ok((await publicPage(handle)).studio);
  const at = (method, path, body) =>
    fetch(`${stack.api}${path}`, {
      method,
      headers: browserHeaders(cookie),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const release = async () =>
    (await (await fetch(`${stack.api}/health/release`)).json()).data;
  assert.equal((await release()).pageStudio, true);
  await setSwitch(database.pool, 'page_studio', false);
  try {
    // The web's preview route (/studio-preview) reads this and answers 404 while it is off.
    assert.equal((await release()).pageStudio, false);
    for (const [method, path, body] of [
      ['GET', '/v1/me/studio'],
      ['PUT', '/v1/me/studio/draft', { rev: 0, draft: v2() }],
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
    draft: withBlocks([title('blk00001')]),
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
  const draft = withBlocks([
    title('blk00001'),
    photoBlock('blk00002', imageId),
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

// "From your photo" (styles spec §6; plan Task 11, Review Focus 3). Generated avatars only.

/** A generated avatar: a background and a large block of a second colour. */
const avatarPhoto = (background, block) =>
  sharp({ create: { width: 600, height: 600, channels: 3, background } })
    .composite([
      {
        input: Buffer.from(
          `<svg width="600" height="600"><rect x="0" y="360" width="600" height="240" fill="${block}"/></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg()
    .toBuffer();
const BLUE = () => avatarPhoto({ r: 40, g: 110, b: 210 }, '#1e3a8a');
const GREEN = () => avatarPhoto({ r: 11, g: 122, b: 75 }, '#d81b60');
const GREY = () => avatarPhoto({ r: 128, g: 128, b: 128 }, '#5a5a5a');
async function uploadAvatar(cookie, bytes) {
  const response = await fetch(`${stack.api}/v1/me/avatar`, {
    method: 'PUT',
    headers: { ...browserHeaders(cookie), 'content-type': 'image/jpeg' },
    body: await bytes,
  });
  assert.equal(response.status, 200, await response.text());
}
const removeAvatar = async (cookie) =>
  assert.equal((await call(cookie, 'DELETE', '/v1/me/avatar')).status, 200);
const storedAccent = async (profileId) =>
  (
    await q(
      `SELECT s.photo_accent, p.avatar_version FROM page_studios s
         JOIN profiles p ON p.id = s.profile_id WHERE s.profile_id = $1`,
      [profileId],
    )
  )[0];
/** The revalidation is sent after the answer: wait for it a moment. */
async function revalidatedFor(handle, count) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const seen = revalidations.filter((r) => r.handle === handle);
    if (seen.length >= count || Date.now() > deadline) return seen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
/**
 * Saves share one address here, and the whole file saves more than the 60 a minute a person gets
 * (`studio_drafts`): each photo-accent test starts with a fresh allowance.
 */
async function freshSaveAllowance() {
  const redis = new Redis(REDIS_URL);
  try {
    const keys = await redis.keys(`rl:${stack.prefix}:studio_drafts:*`);
    if (keys.length) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
const PROFILE_CHANGED = /^data: \{"type":"profile\.changed"\}$/;
async function eventsOf(t, cookie) {
  const stream = await openEventStream(`${stack.api}/v1/me/events`, {
    cookie,
    origin: WEB,
  });
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  await stream.waitFor(/^data: \{"type":"ready"\}$/);
  return stream;
}
const changedCount = (stream) =>
  stream.frames.filter((f) => PROFILE_CHANGED.test(f)).length;
async function waitForChanged(stream, count) {
  const deadline = Date.now() + 5000;
  while (changedCount(stream) < count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(changedCount(stream), count, JSON.stringify(stream.frames));
}

test('choosing "From your photo" on Pro stores a photo accent for the current avatar', async () => {
  await freshSaveAllowance();
  const { cookie, handle, profileId } = await page();
  await uploadAvatar(cookie, BLUE());
  const design = v2({ style: 'clear', accent: 'photo' });
  const saved = await json(await save(cookie, 0, design));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const mine = saved.body.data.photoAccent;
  assert.ok(mine && !('failed' in mine), JSON.stringify(mine));
  const row = await storedAccent(profileId);
  assert.equal(row.photo_accent.source, 'avatar');
  assert.equal(row.photo_accent.avatarVersion, row.avatar_version);
  assert.deepEqual(
    { light: row.photo_accent.light, dark: row.photo_accent.dark },
    mine,
  );
  assert.deepEqual((await studio(cookie)).photoAccent, mine);
  assert.equal((await publish(cookie, saved.body.data.rev)).status, 200);
  const shown = (await publicPage(handle)).studio;
  assert.deepEqual(shown.document, design);
  assert.deepEqual(shown.palette, studioTokens('clear', 'photo', mine));
  assert.notDeepEqual(shown.palette, studioTokens('clear', null));
});

test('a new or removed avatar recomputes or clears the photo accent and revalidates the page', async (t) => {
  await freshSaveAllowance();
  const { cookie, handle, profileId } = await page();
  await uploadAvatar(cookie, BLUE());
  const design = v2({ style: 'journal', accent: 'photo' });
  const saved = (await json(await save(cookie, 0, design))).body.data;
  assert.equal((await publish(cookie, saved.rev)).status, 200);
  const before = await storedAccent(profileId);
  const blue = (await publicPage(handle)).studio.palette;
  assert.deepEqual(
    blue,
    studioTokens('journal', 'photo', {
      light: before.photo_accent.light,
      dark: before.photo_accent.dark,
    }),
  );
  const events = await eventsOf(t, cookie);
  const seen = (await revalidatedFor(handle, 0)).length;

  // A new photo: a new accent for its version, stored before the page is refreshed.
  await uploadAvatar(cookie, GREEN());
  const after = await storedAccent(profileId);
  assert.equal(after.avatar_version, before.avatar_version + 1);
  assert.equal(after.photo_accent.avatarVersion, after.avatar_version);
  const green = (await publicPage(handle)).studio.palette;
  assert.notDeepEqual(green, blue);
  assert.deepEqual(
    green,
    studioTokens('journal', 'photo', {
      light: after.photo_accent.light,
      dark: after.photo_accent.dark,
    }),
  );
  const refreshed = await revalidatedFor(handle, seen + 1);
  assert.equal(refreshed.length, seen + 1);
  assert.equal(
    refreshed.at(-1).photoAccent.avatarVersion,
    after.avatar_version,
    'the page is refreshed after the new accent is stored',
  );
  await waitForChanged(events, 1);

  // No photo: the style's own accent, never the stale one, never an error.
  await removeAvatar(cookie);
  assert.equal((await storedAccent(profileId)).photo_accent, null);
  const none = await publicPage(handle);
  assert.deepEqual(none.studio.document, design);
  assert.deepEqual(none.studio.palette, studioTokens('journal', null));
  assert.equal((await studio(cookie)).photoAccent, null);
  const cleared = await revalidatedFor(handle, seen + 2);
  assert.equal(cleared.length, seen + 2);
  assert.equal(cleared.at(-1).photoAccent, null);
  await waitForChanged(events, 2);

  // A photo again: an accent again, for that photo.
  await uploadAvatar(cookie, BLUE());
  const again = await storedAccent(profileId);
  assert.equal(again.photo_accent.avatarVersion, again.avatar_version);
  assert.deepEqual((await publicPage(handle)).studio.palette, blue);
});

test('a stored photo accent for an older photo is never shown', async () => {
  await freshSaveAllowance();
  const { cookie, handle, profileId } = await page();
  await uploadAvatar(cookie, BLUE());
  const saved = (
    await json(await save(cookie, 0, v2({ style: 'linen', accent: 'photo' })))
  ).body.data;
  assert.equal((await publish(cookie, saved.rev)).status, 200);
  // As if the photo changed while Page Studio was off: the stored values name the old photo.
  await q(
    'UPDATE profiles SET avatar_version = avatar_version + 1 WHERE id = $1',
    [profileId],
  );
  assert.deepEqual(
    (await publicPage(handle)).studio.palette,
    studioTokens('linen', null),
  );
  assert.equal((await studio(cookie)).photoAccent, null);
});

test("Free can't choose the photo accent (403)", async () => {
  await freshSaveAllowance();
  const { cookie, profileId } = await page({ pro: false });
  await uploadAvatar(cookie, BLUE());
  const refused = await json(
    await save(cookie, 0, v2({ style: 'clear', accent: 'photo' })),
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'STUDIO_PRO_REQUIRED');
  assert.equal(await storedAccent(profileId), undefined, 'nothing stored');
});

test('a grey photo publishes with the Ink fallback and the editor gets the no-clear-colour sentence', async () => {
  await freshSaveAllowance();
  const { cookie, handle, profileId } = await page();
  await uploadAvatar(cookie, GREY());
  const saved = (
    await json(await save(cookie, 0, v2({ style: 'linen', accent: 'photo' })))
  ).body.data;
  assert.deepEqual(saved.photoAccent, {
    failed: true,
    fallback: 'ink',
    noUsableColour: true,
  });
  const stored = await storedAccent(profileId);
  assert.deepEqual(stored.photo_accent, {
    failed: true,
    fallback: 'ink',
    noUsableColour: true,
    avatarVersion: stored.avatar_version,
  });
  assert.equal(
    photoAccentNotice(saved.photoAccent),
    "We couldn't find a clear colour in your photo, so your page uses Ink.",
  );
  const done = await json(await publish(cookie, saved.rev));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(
    (await publicPage(handle)).studio.palette,
    studioTokens('linen', 'ink'),
  );
});

test('with the page_studio switch off, a photo change leaves the photo accent as it is', async () => {
  await freshSaveAllowance();
  const { cookie, profileId } = await page();
  await uploadAvatar(cookie, BLUE());
  await save(cookie, 0, v2({ style: 'clear', accent: 'photo' }));
  const before = await storedAccent(profileId);
  assert.ok(before.photo_accent);
  await setSwitch(database.pool, 'page_studio', false);
  try {
    await uploadAvatar(cookie, GREEN());
    await removeAvatar(cookie);
    assert.deepEqual(
      (await storedAccent(profileId)).photo_accent,
      before.photo_accent,
    );
  } finally {
    await setSwitch(database.pool, 'page_studio', true);
  }
});

test('a fallback never outlives its photo: a new photo that cannot be sampled shows the style’s own accent', async (t) => {
  await freshSaveAllowance();
  const { cookie, handle, profileId } = await page();
  await uploadAvatar(cookie, GREY());
  const saved = (
    await json(await save(cookie, 0, v2({ style: 'linen', accent: 'photo' })))
  ).body.data;
  assert.deepEqual(saved.photoAccent, {
    failed: true,
    fallback: 'ink',
    noUsableColour: true,
  });
  assert.equal((await publish(cookie, saved.rev)).status, 200);
  assert.deepEqual(
    (await publicPage(handle)).studio.palette,
    studioTokens('linen', 'ink'),
  );
  // The sampler fails for the next photo.
  const service = stack.app.get(StudioPhotoAccent);
  const sample = service.sample;
  service.sample = async () => {
    throw new Error('sampling failed');
  };
  t.after(() => (service.sample = sample));
  await uploadAvatar(cookie, GREEN());
  assert.equal(
    (await storedAccent(profileId)).photo_accent,
    null,
    'cleared for the new photo, not kept from the old one',
  );
  // The style's own accent (Linen: Coral), not the old photo's Ink, and no sentence about it.
  assert.deepEqual(
    (await publicPage(handle)).studio.palette,
    studioTokens('linen', null),
  );
  const mine = await studio(cookie);
  assert.equal(mine.photoAccent, null);
  assert.equal(photoAccentNotice(mine.photoAccent), null);
  // A save with sampling still failing keeps it that way; once it works, the save computes it.
  const again = (await json(await save(cookie, mine.rev, mine.draft))).body
    .data;
  assert.equal(again.photoAccent, null);
  service.sample = sample;
  const fixed = (await json(await save(cookie, again.rev, again.draft))).body
    .data;
  assert.ok(fixed.photoAccent && !('failed' in fixed.photoAccent));
  const row = await storedAccent(profileId);
  assert.equal(row.photo_accent.avatarVersion, row.avatar_version);
});

test('a fallback stored for an older photo is never shown', async () => {
  await freshSaveAllowance();
  const { cookie, handle, profileId } = await page();
  await uploadAvatar(cookie, GREY());
  const saved = (
    await json(await save(cookie, 0, v2({ style: 'linen', accent: 'photo' })))
  ).body.data;
  assert.equal((await publish(cookie, saved.rev)).status, 200);
  // As if the photo changed while Page Studio was off.
  await q(
    'UPDATE profiles SET avatar_version = avatar_version + 1 WHERE id = $1',
    [profileId],
  );
  assert.deepEqual(
    (await publicPage(handle)).studio.palette,
    studioTokens('linen', null),
  );
  assert.equal((await studio(cookie)).photoAccent, null);
});

test('when Pro lapses, a published photo accent goes back to the style’s own accent', async () => {
  await freshSaveAllowance();
  const free = await page();
  await uploadAvatar(free.cookie, BLUE());
  const journal = v2({ style: 'journal', accent: 'photo' });
  const a = (await json(await save(free.cookie, 0, journal))).body.data;
  assert.ok(a.photoAccent && !('failed' in a.photoAccent));
  assert.equal((await publish(free.cookie, a.rev)).status, 200);
  assert.deepEqual(
    (await publicPage(free.handle)).studio.palette,
    studioTokens('journal', 'photo', a.photoAccent),
  );
  await setPlan(free.profileId, 'free');
  const shown = (await publicPage(free.handle)).studio;
  assert.equal(shown.document.accent, null);
  assert.deepEqual(shown.palette, studioTokens('journal', null));
  // Nothing is deleted: Pro again shows the photo accent again.
  assert.ok((await storedAccent(free.profileId)).photo_accent);
  await setPlan(free.profileId, 'pro');
  assert.deepEqual(
    (await publicPage(free.handle)).studio.palette,
    studioTokens('journal', 'photo', a.photoAccent),
  );

  // A Pro style lapses to Classic, with Classic's own purple.
  const pro = await page();
  await uploadAvatar(pro.cookie, BLUE());
  const b = (
    await json(
      await save(pro.cookie, 0, v2({ style: 'stage', accent: 'photo' })),
    )
  ).body.data;
  assert.equal((await publish(pro.cookie, b.rev)).status, 200);
  await setPlan(pro.profileId, 'free');
  const classic = (await publicPage(pro.handle)).studio;
  assert.equal(classic.document.style, 'classic');
  assert.equal(classic.document.accent, null);
  assert.deepEqual(classic.palette, studioTokens('classic', null));
});
