import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import {
  mailSealing,
  setCover,
  staffRemovePageImage,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// Staff review a page's cover and photo and can remove either alone, without pausing the page:
// audited, with a written reason, under `pages.suspend`. The owner is told; the reason stays private.
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
let staff;
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
  staff = await opsSignIn(stack.api, database.db, '+2348031300099');
});
after(async () => {
  await stack.stop();
  await database.close();
});

const REASON = 'Abusive image reported by a visitor, seen by staff';
const image = () =>
  sharp({
    create: { width: 800, height: 600, channels: 3, background: '#7A32F9' },
  })
    .jpeg()
    .toBuffer();

async function pageWithImages(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  const send = (method, path, body, headers = {}) =>
    fetch(`${stack.api}${path}`, {
      method,
      headers: { ...browserHeaders(cookie), ...headers },
      ...(body === undefined ? {} : { body }),
    });
  await send('POST', '/v1/me/page', JSON.stringify({ handle }));
  await send('PUT', '/v1/me/page/state', JSON.stringify({ state: 'live' }));
  const photo = await send('PUT', '/v1/me/avatar', await image(), {
    'content-type': 'image/jpeg',
  });
  const avatarPath = (await photo.json()).data.avatarPath;
  const uploaded = await send('PUT', '/v1/me/cover', await image(), {
    'content-type': 'image/jpeg',
  });
  const coverPath = (await uploaded.json()).data.cover.path;
  return { cookie, avatarPath, coverPath, profileId: coverPath.split('/')[3] };
}

const staffView = (profileId, kind, cookie = staff.cookie) =>
  fetch(`${stack.api}/v1/ops/pages/${profileId}/images/${kind}`, {
    headers: { cookie },
  });
const staffRemove = (profileId, kind, reason = REASON, cookie = staff.cookie) =>
  fetch(`${stack.api}/v1/ops/pages/${profileId}/images/${kind}/remove`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ reason }),
  });
const audits = async (profileId, action) =>
  (
    await database.pool.query(
      `SELECT permission, reason, staff_user_id FROM audit_events WHERE subject_id = $1 AND action = $2`,
      [profileId, action],
    )
  ).rows;
test('staff can view a cover and a photo, even on a paused page, and each view is audited', async () => {
  const { profileId, coverPath } = await pageWithImages(
    '+2348031300001',
    'mod_view',
  );
  await database.pool.query(
    `UPDATE profiles SET status = 'suspended', suspended_reason = 'Under review' WHERE id = $1`,
    [profileId],
  );
  assert.equal((await fetch(`${stack.api}${coverPath}`)).status, 404);
  for (const [kind, action, width] of [
    ['cover', 'page.cover_viewed', 2240],
    ['photo', 'page.photo_viewed', 512],
  ]) {
    const seen = await staffView(profileId, kind);
    assert.equal(seen.status, 200, kind);
    assert.equal(seen.headers.get('content-type'), 'image/webp');
    assert.equal(seen.headers.get('cache-control'), 'private, no-store');
    assert.equal(seen.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      (await sharp(Buffer.from(await seen.arrayBuffer())).metadata()).width,
      width,
    );
    const [audit] = await audits(profileId, action);
    assert.equal(audit.permission, 'pages.suspend');
  }
});

test('only staff with the pause permission can view or remove', async () => {
  const { profileId, cookie, coverPath } = await pageWithImages(
    '+2348031300002',
    'mod_gate',
  );
  // Not staff: the admin area hides itself, even from the page's owner.
  assert.equal((await staffView(profileId, 'cover', cookie)).status, 404);
  assert.equal(
    (await staffRemove(profileId, 'cover', REASON, cookie)).status,
    404,
  );
  assert.equal((await fetch(`${stack.api}${coverPath}`)).status, 200);
  // Unknown kinds and malformed ids are simply not found.
  assert.equal((await staffView(profileId, 'banner')).status, 404);
  assert.equal((await staffView('not-a-uuid', 'cover')).status, 404);
  assert.equal((await staffRemove(profileId, 'banner')).status, 404);
  // Staff without the permission.
  const other = await opsSignIn(stack.api, database.db, '+2348031300098');
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('viewer', 'Viewer') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'viewer' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348031300098')`,
  );
  assert.equal((await staffView(profileId, 'cover', other.cookie)).status, 403);
  assert.equal(
    (await staffRemove(profileId, 'cover', REASON, other.cookie)).status,
    403,
  );
  assert.equal((await audits(profileId, 'page.cover_viewed')).length, 0);
});

test('the page screen says which images a page has', async () => {
  const { profileId } = await pageWithImages('+2348031300003', 'mod_flags');
  const look = async () =>
    (
      await (
        await fetch(`${stack.api}/v1/ops/pages/mod_flags`, {
          headers: { cookie: staff.cookie },
        })
      ).json()
    ).data.images;
  assert.deepEqual(await look(), { hasCover: true, hasPhoto: true });
  await staffRemove(profileId, 'cover');
  assert.deepEqual(await look(), { hasCover: false, hasPhoto: true });
});

// The email to the owner is tested in packages/database/test/integration/mail-triggers.test.mjs.
for (const [kind, action, pathOf] of [
  ['cover', 'page.cover_removed', (p) => p.coverPath],
  ['photo', 'page.photo_removed', (p) => p.avatarPath],
])
  test(`removing a ${kind} takes it down for good, audited, with the owner told`, async () => {
    const phone = kind === 'cover' ? '+2348031300004' : '+2348031300005';
    const handle = `mod_gone_${kind}`;
    const page = await pageWithImages(phone, handle);
    const { profileId, cookie } = page;
    const url = pathOf(page);
    assert.equal((await fetch(`${stack.api}${url}`)).status, 200);

    assert.equal((await staffRemove(profileId, kind, 'short')).status, 400);
    assert.equal((await fetch(`${stack.api}${url}`)).status, 200);

    const removed = await staffRemove(profileId, kind);
    assert.equal(removed.status, 200);
    assert.equal((await fetch(`${stack.api}${url}`)).status, 404);
    const [audit] = await audits(profileId, action);
    assert.equal(audit.permission, 'pages.suspend');
    assert.equal(audit.reason, REASON);
    assert.equal((await staffView(profileId, kind)).status, 404);

    // Pausing and restoring the page doesn't bring it back.
    for (const route of ['suspend', 'unsuspend'])
      assert.equal(
        (
          await fetch(`${stack.api}/v1/ops/pages/${profileId}/${route}`, {
            method: 'POST',
            headers: browserHeaders(staff.cookie),
            body: JSON.stringify({ reason: REASON }),
          })
        ).status,
        200,
      );
    assert.equal((await fetch(`${stack.api}${url}`)).status, 404);
    const public_ = (
      await (await fetch(`${stack.api}/v1/profiles/${handle}`)).json()
    ).data;
    if (kind === 'cover') assert.equal(public_.cover.kind, 'design');
    else assert.equal(public_.avatarPath, undefined);

    // Removing again (a stale screen) records and sends nothing.
    assert.equal((await staffRemove(profileId, kind)).status, 200);
    assert.equal((await audits(profileId, action)).length, 1);

    // The owner's next upload gets a URL never used before.
    const again = await fetch(
      `${stack.api}/v1/me/${kind === 'cover' ? 'cover' : 'avatar'}`,
      {
        method: 'PUT',
        headers: { ...browserHeaders(cookie), 'content-type': 'image/jpeg' },
        body: await image(),
      },
    );
    const mine = (await again.json()).data;
    assert.notEqual(kind === 'cover' ? mine.cover.path : mine.avatarPath, url);
    assert.equal((await fetch(`${stack.api}${url}`)).status, 404);
  });

test('removing a stored image removes its object, after the commit', async () => {
  const { profileId } = await pageWithImages('+2348031300006', 'mod_store');
  const [{ user_id: userId }] = (
    await database.pool.query('SELECT user_id FROM profiles WHERE id = $1', [
      profileId,
    ])
  ).rows;
  const objects = new Map();
  let pathAtRemove;
  const store = {
    endpoint: 'memory://',
    async put(key, webp) {
      objects.set(key, webp);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async remove(key) {
      pathAtRemove = (
        await database.pool.query(
          'SELECT cover_path FROM profiles WHERE id = $1',
          [profileId],
        )
      ).rows[0].cover_path;
      objects.delete(key);
    },
  };
  await setCover(database.db, userId, Buffer.from('RIFF0000WEBPVP8 x'), store);
  objects.clear();
  await setCover(database.db, userId, Buffer.from('RIFF0000WEBPVP8 y'), store);
  assert.equal(objects.size, 1);
  const result = await staffRemovePageImage(database.db, {
    profileId,
    staffUserId: (
      await database.pool.query(
        `SELECT id FROM users WHERE phone_e164 = '+2348031300099'`,
      )
    ).rows[0].id,
    image: 'cover',
    reason: REASON,
    sealing: mailSealing(Buffer.alloc(32, 7)),
    store,
  });
  assert.equal(result.changed, true);
  assert.equal(objects.size, 0);
  assert.equal(pathAtRemove, null);
});
