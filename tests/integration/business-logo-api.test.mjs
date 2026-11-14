import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  seedBusiness,
  seedManager,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// A business's logo (owner, 6 Nov 2026): the page photo's pipeline for a business. Owners only,
// audited; re-encoded to a 512×512 WebP with no metadata; served publicly only while verified.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const sharp = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('sharp');

const [ADA, TOBI] = DEMO_PROFILES;
let database;
let stack;
let ada;
let tobi;
let stranger;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
  ada = await signIn(stack.api, ADA.phone);
  tobi = await signIn(stack.api, TOBI.phone);
  stranger = await signIn(stack.api, '+2348031295001');
});
after(async () => {
  await stack.stop();
  await database.close();
});

const logoUrl = (businessId) =>
  `${stack.api}/v1/me/businesses/${businessId}/logo`;
const upload = (cookie, businessId, body, type = 'image/jpeg') =>
  fetch(logoUrl(businessId), {
    method: 'PUT',
    headers: { ...browserHeaders(cookie), 'content-type': type },
    body,
  });
const remove = (cookie, businessId) =>
  fetch(logoUrl(businessId), {
    method: 'DELETE',
    headers: browserHeaders(cookie),
  });

/** A real photo-like JPEG with location and camera metadata in it. */
const photo = () =>
  sharp({
    create: {
      width: 900,
      height: 600,
      channels: 3,
      background: { r: 122, g: 50, b: 249 },
    },
  })
    .withExif({
      IFD0: { Make: 'SecretCam', Copyright: 'Funke Home Address' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 27/1 0/1' },
    })
    .jpeg()
    .toBuffer();

const audits = async (businessId) =>
  (
    await database.pool.query(
      `SELECT action, staff_user_id FROM audit_events WHERE subject_id = $1 ORDER BY seq`,
      [businessId],
    )
  ).rows;

test('an owner sets a logo: a 512×512 WebP with no metadata, on the public location page, audited', async () => {
  const { businessId, slug } = await seedBusiness(database, {
    owner: ADA.userId,
  });
  const original = await photo();
  assert.ok(original.includes(Buffer.from('SecretCam')));
  const response = await upload(ada.cookie, businessId, original);
  assert.equal(response.status, 200);
  const detail = (await response.json()).data;
  assert.match(
    detail.logoPath,
    new RegExp(`^/v1/business-logos/${businessId}/\\d+\\.webp$`),
  );

  const served = await fetch(`${stack.api}${detail.logoPath}`);
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
  for (const leak of ['SecretCam', 'Funke Home Address'])
    assert.equal(bytes.includes(Buffer.from(leak)), false, leak);

  // The web app draws the logo on a printed sign's canvas and downloads it: the browser loads it
  // with CORS (crossOrigin "anonymous"), so the API allows the web app's origin, never credentials,
  // and no other origin.
  const cors = await fetch(`${stack.api}${detail.logoPath}`, {
    headers: { origin: WEB },
  });
  assert.equal(cors.status, 200);
  assert.equal(cors.headers.get('access-control-allow-origin'), WEB);
  assert.equal(cors.headers.get('access-control-allow-credentials'), null);
  const elsewhere = await fetch(`${stack.api}${detail.logoPath}`, {
    headers: { origin: 'https://elsewhere.example' },
  });
  assert.equal(elsewhere.headers.get('access-control-allow-origin'), null);

  // The codes a manager prints carry the logo, so the sign's tile shows it.
  const codes = await fetch(
    `${stack.api}/v1/me/businesses/${businessId}/codes`,
    { headers: browserHeaders(ada.cookie) },
  );
  assert.equal(codes.status, 200);
  assert.equal((await codes.json()).data.business.logoPath, detail.logoPath);

  const page = (await (await fetch(`${stack.api}/v1/b/${slug}/vi`)).json())
    .data;
  assert.equal(page.business.logoPath, detail.logoPath);
  const home = (await (await fetch(`${stack.api}/v1/b/${slug}`)).json()).data;
  assert.equal(home.business.logoPath, detail.logoPath);

  // A new logo is a new URL; the old one stops working.
  const second = (
    await (await upload(ada.cookie, businessId, await photo())).json()
  ).data;
  assert.notEqual(second.logoPath, detail.logoPath);
  assert.equal((await fetch(`${stack.api}${detail.logoPath}`)).status, 404);

  // Remove logo: the tile shows the initial again and the URL is gone.
  const removed = await remove(ada.cookie, businessId);
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).data.logoPath, undefined);
  assert.equal((await fetch(`${stack.api}${second.logoPath}`)).status, 404);
  const after = (await (await fetch(`${stack.api}/v1/b/${slug}/vi`)).json())
    .data;
  assert.equal(after.business.logoPath, undefined);

  assert.deepEqual(await audits(businessId), [
    { action: 'business.logo_set', staff_user_id: ADA.userId },
    { action: 'business.logo_set', staff_user_id: ADA.userId },
    { action: 'business.logo_removed', staff_user_id: ADA.userId },
  ]);
});

test('a location manager is refused (403), a stranger is told it does not exist (404), signed out is refused', async () => {
  const { businessId, locations } = await seedBusiness(database, {
    owner: ADA.userId,
  });
  await seedManager(database, {
    businessId,
    userId: TOBI.userId,
    locationId: locations[0].id,
  });
  const manager = await upload(tobi.cookie, businessId, await photo());
  assert.equal(manager.status, 403);
  assert.equal((await manager.json()).error.code, 'OWNER_REQUIRED');
  assert.equal((await remove(tobi.cookie, businessId)).status, 403);

  const outsider = await upload(stranger.cookie, businessId, await photo());
  assert.equal(outsider.status, 404);
  assert.equal((await remove(stranger.cookie, businessId)).status, 404);
  assert.equal(
    (
      await fetch(logoUrl(businessId), {
        headers: browserHeaders(stranger.cookie),
      })
    ).status,
    404,
  );

  const signedOut = await fetch(logoUrl(businessId), {
    method: 'PUT',
    headers: { origin: WEB, 'content-type': 'image/jpeg' },
    body: await photo(),
  });
  assert.equal(signedOut.status, 401);

  const [row] = (
    await database.pool.query(
      `SELECT logo_path FROM businesses WHERE id = $1`,
      [businessId],
    )
  ).rows;
  assert.equal(row.logo_path, null);
  assert.deepEqual(await audits(businessId), []);

  // The location manager still sees the owner's logo in the dashboard once there is one.
  await upload(ada.cookie, businessId, await photo());
  const preview = await fetch(logoUrl(businessId), {
    headers: browserHeaders(tobi.cookie),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
});

test('anything that is not a real JPEG, PNG or WebP is refused, and so is a file over 5 MB', async () => {
  const { businessId } = await seedBusiness(database, { owner: ADA.userId });
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  assert.equal(
    (await upload(ada.cookie, businessId, svg, 'image/svg+xml')).status,
    415,
  );
  const garbage = await upload(
    ada.cookie,
    businessId,
    Buffer.from('not really a jpeg at all'),
  );
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).error.code, 'INVALID_IMAGE');
  const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
  assert.equal((await upload(ada.cookie, businessId, huge)).status, 413);
  assert.deepEqual(await audits(businessId), []);
});

test('a waiting or paused business can set a logo, but it is served only to its managers until verified', async () => {
  for (const status of ['pending', 'suspended']) {
    const { businessId } = await seedBusiness(database, {
      owner: ADA.userId,
      status,
    });
    const response = await upload(ada.cookie, businessId, await photo());
    assert.equal(response.status, 200, status);
    const { logoPath } = (await response.json()).data;
    assert.equal((await fetch(`${stack.api}${logoPath}`)).status, 404, status);
    const own = await fetch(logoUrl(businessId), {
      headers: browserHeaders(ada.cookie),
    });
    assert.equal(own.status, 200, status);
    assert.equal(own.headers.get('content-type'), 'image/webp');
  }
});
