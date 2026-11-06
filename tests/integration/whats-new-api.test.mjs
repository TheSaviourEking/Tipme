import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Changelog plan (5 Nov 2026), Task 6.2: GET /v1/me/whats-new, GET /v1/me/whats-new/status and
// POST /v1/me/whats-new/seen. Entries are seeded with SQL (the ingest and admin PRs are separate).

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const TOBI = DEMO_PROFILES[1];
let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  await database.pool.query("UPDATE profiles SET created_at = '2026-10-01'");
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

async function seed(number, values = {}) {
  const audience = values.audience ?? 'everyone';
  const text =
    audience === 'staff' ? null : (values.text ?? `Update ${number}.`);
  await database.pool.query(
    `INSERT INTO changelog_entries (pr_number, merge_sha, merged_at, pr_title, staff_text, user_text,
       audience, published_text, published_audience, published_revision, approved_at, approved_by,
       live_at, withdrawn_at, withdrawn_by, withdrawn_reason)
     VALUES ($1, $2, '2026-11-01T10:00:00Z', $3, $4, $5, $6, $5, $6, 1, '2026-11-02T10:00:00Z', $7,
       $8, $9, $10, $11)`,
    [
      number,
      String(number).padStart(40, 'a'),
      `fix(api): secret staff title ${number}`,
      `STAFF-ONLY-NOTE ${number}`,
      text,
      audience,
      TOBI.userId,
      values.liveAt ?? '2026-11-05T10:00:00Z',
      values.withdrawn ? '2026-11-05T12:00:00Z' : null,
      values.withdrawn ? TOBI.userId : null,
      values.withdrawn ? 'Rolled back' : null,
    ],
  );
}

// Sign-in codes are limited per phone, so each device signs in once for the whole file. One after
// the other: the second's code would replace the first's in the pretend inbox.
let devices;
const sessions = () =>
  (devices ??= (async () => {
    const phone = await signIn(stack.api, TOBI.phone);
    const laptop = await signIn(stack.api, TOBI.phone);
    return [phone, laptop];
  })());

const get = async (path, cookie) => {
  const response = await fetch(`${stack.api}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: response.status === 200 ? await response.json() : null,
  };
};

const seen = (cookie, through, headers = browserHeaders(cookie)) =>
  fetch(`${stack.api}/v1/me/whats-new/seen`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ through }),
  });

test("signed out gets 401 on every What's new route", async () => {
  assert.equal((await get('/v1/me/whats-new')).status, 401);
  assert.equal((await get('/v1/me/whats-new/status')).status, 401);
  assert.equal(
    (await seen(undefined, '2026-11-05T10:00:00Z', browserHeaders())).status,
    401,
  );
});

test('the list and the status agree; staff-only and withdrawn entries never appear', async () => {
  await database.pool.query('DELETE FROM changelog_entries');
  await database.pool.query('DELETE FROM changelog_reads');
  await seed(301, { liveAt: '2026-11-03T10:00:00Z' });
  await seed(302, {
    audience: 'pro',
    text: 'You can pick a starting amount.',
    liveAt: '2026-11-05T10:00:00Z',
  });
  await seed(303, { audience: 'staff' });
  await seed(304, { withdrawn: true });
  const [{ cookie }] = await sessions();
  const list = await get('/v1/me/whats-new', cookie);
  assert.equal(list.status, 200);
  assert.equal(list.cacheControl, 'private, no-store');
  assert.deepEqual(list.body.data, {
    entries: [
      {
        number: 302,
        line: 'On Pro, you can pick a starting amount.',
        pro: true,
        liveOn: '2026-11-05',
        liveAt: '2026-11-05T10:00:00.000Z',
      },
      {
        number: 301,
        line: 'Update 301.',
        pro: false,
        liveOn: '2026-11-03',
        liveAt: '2026-11-03T10:00:00.000Z',
      },
    ],
    unseen: 2,
  });
  const status = await get('/v1/me/whats-new/status', cookie);
  assert.equal(status.cacheControl, 'private, no-store');
  assert.deepEqual(status.body.data, {
    unseen: 2,
    newest: list.body.data.entries[0],
  });
  // No PR title, staff text or anything else staff wrote reaches users.
  const text = JSON.stringify([list.body, status.body]);
  assert.doesNotMatch(
    text,
    /STAFF-ONLY-NOTE|secret staff title|prTitle|staffText/,
  );
});

test('a CSRF-less or malformed seen is refused and moves nothing', async () => {
  const [{ cookie }] = await sessions();
  await database.pool.query('DELETE FROM changelog_reads');
  const noHeader = await seen(cookie, '2026-11-05T10:00:00Z', {
    'content-type': 'application/json',
    cookie,
  });
  assert.equal(noHeader.status, 403);
  const otherOrigin = await seen(cookie, '2026-11-05T10:00:00Z', {
    ...browserHeaders(cookie),
    origin: 'https://evil.example',
  });
  assert.equal(otherOrigin.status, 403);
  assert.equal((await seen(cookie, 'yesterday')).status, 400);
  const extra = await fetch(`${stack.api}/v1/me/whats-new/seen`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ through: '2026-11-05T10:00:00Z', userId: 'x' }),
  });
  assert.equal(extra.status, 400);
  const { rows } = await database.pool.query('SELECT 1 FROM changelog_reads');
  assert.equal(rows.length, 0);
});

test('seen on one device clears unseen for a second session of the same person', async () => {
  await database.pool.query('DELETE FROM changelog_entries');
  await database.pool.query('DELETE FROM changelog_reads');
  await seed(311, { liveAt: '2026-11-04T10:00:00Z' });
  await seed(312, { liveAt: '2026-11-05T10:00:00Z' });
  const [phone, laptop] = await sessions();
  assert.notEqual(phone.cookie, laptop.cookie);
  assert.equal(
    (await get('/v1/me/whats-new/status', laptop.cookie)).body.data.unseen,
    2,
  );
  const response = await seen(phone.cookie, '2026-11-05T10:00:00.000Z');
  assert.equal(response.status, 204);
  assert.equal(
    (await get('/v1/me/whats-new/status', laptop.cookie)).body.data.unseen,
    0,
  );
  // A stale tab sending an older instant never brings the dot back.
  assert.equal((await seen(laptop.cookie, '2026-11-01T00:00:00Z')).status, 204);
  assert.equal(
    (await get('/v1/me/whats-new/status', phone.cookie)).body.data.unseen,
    0,
  );
  // A newer update shows again, on both.
  await seed(313, { liveAt: '2026-11-06T09:00:00Z' });
  for (const device of [phone, laptop])
    assert.equal(
      (await get('/v1/me/whats-new/status', device.cookie)).body.data.unseen,
      1,
    );
});
