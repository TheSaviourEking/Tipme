import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// People (owner's ask, 14 Nov 2026): every account, paginated, for search.view. Emails are masked
// for everyone in the list; the full address is a reveal with a reason (private.view), as for a
// business contact. Money (totals, the "most tips" sort) is private.view only, refused by the API.

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const REASON = 'Checking who owns this account for a ticket';
let database;
let stack;
let owner;
let searcher;
let plain;

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const idOf = async (phone) =>
  (await q(`SELECT id FROM users WHERE phone_e164 = $1`, [phone]))[0].id;
const roleWith = async (permissions) => {
  const id = `role_${randomUUID().slice(0, 8)}`;
  await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [id]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
  return id;
};

/** One account, with what the test needs of it. Returns the user id (and profile id, if any). */
async function account({
  createdAt,
  email = null,
  handle = null,
  name = handle,
  plan = 'free',
  pageState = 'live',
  suspended = false,
  payouts = false,
  tipsMinor = [],
  business = null,
  lastSeenAt = null,
} = {}) {
  const userId = randomUUID();
  await q(`INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3)`, [
    userId,
    email,
    createdAt,
  ]);
  let profileId = null;
  if (handle) {
    profileId = randomUUID();
    await q(
      `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, plan, status, suspended_reason, created_at)
       VALUES ($1, $2, $3, lower($3), $4, $5, $6, $7, $8, $9)`,
      [
        profileId,
        userId,
        handle,
        name,
        pageState,
        plan,
        suspended ? 'suspended' : 'active',
        suspended ? 'Test suspension' : null,
        createdAt,
      ],
    );
    if (payouts)
      await q(
        `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
         VALUES (gen_random_uuid(), $1, 'mock', $2, '058', 'Test Bank', '1234', 'usable')`,
        [profileId, `dest_${randomUUID()}`],
      );
    for (const minor of tipsMinor) {
      const quoteId = randomUUID();
      const intentId = randomUUID();
      await q(
        `INSERT INTO tip_quotes (id, profile_id, currency, tip_minor, platform_fee_minor, provider_fee_minor, payer_total_minor, recipient_net_minor, fee_policy_version, expires_at)
         VALUES ($1, $2, 'NGN', $3, 0, 0, $3, $3, 'test', now())`,
        [quoteId, profileId, minor],
      );
      await q(
        `INSERT INTO payment_intents (id, quote_id, profile_id, idempotency_key, request_fingerprint, status, expires_at)
         VALUES ($1, $2, $3, $4, 'test', 'SUCCEEDED', now())`,
        [intentId, quoteId, profileId, randomUUID()],
      );
      await q(
        `INSERT INTO tips (id, intent_id, profile_id, currency, gross_minor, status, completed_at)
         VALUES (gen_random_uuid(), $1, $2, 'NGN', $3, 'SUCCEEDED', now())`,
        [intentId, profileId, minor],
      );
    }
  }
  if (business) {
    const businessId = randomUUID();
    await q(
      `INSERT INTO businesses (id, slug, name, contact_name, contact_email, created_by)
       VALUES ($1, $2, $3, 'Contact', 'contact@example.com', $4)`,
      [businessId, business.slug, business.name, userId],
    );
    await q(
      `INSERT INTO business_managers (id, business_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'owner')`,
      [businessId, userId],
    );
  }
  if (lastSeenAt)
    await q(
      `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $3, $3::timestamptz + interval '30 days')`,
      [userId, `sha_${randomUUID()}`, lastSeenAt],
    );
  return { userId, profileId };
}

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.ensureOwnerRole(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348037781001');
  searcher = await opsSignIn(stack.api, database.db, '+2348037781002');
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    await idOf('+2348037781002'),
    await roleWith(['search.view']),
  ]);
  plain = await opsSignIn(stack.api, database.db, '+2348037781003');
  await q(`UPDATE staff SET role_id = $2 WHERE user_id = $1`, [
    await idOf('+2348037781003'),
    await roleWith(['analytics.view']),
  ]);
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const list = async (query, cookie = owner.cookie) => {
  const response = await fetch(`${stack.api}/v1/ops/users?${query}`, {
    headers: { cookie },
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
};
const handles = (body) => body.data.items.map((item) => item.handle);

test('pages of 25: totals, the last page, a page past the end, and one stable order across pages', async () => {
  // 60 accounts joined at the same instant: only the id can order them, and it must.
  const at = '2002-02-02T10:00:00Z';
  const made = [];
  for (let i = 0; i < 60; i += 1)
    made.push(
      await account({
        createdAt: at,
        handle: `pgx${String(i).padStart(2, '0')}`,
      }),
    );
  const expected = made
    .map((one) => one.userId)
    .sort()
    .reverse();
  const seen = [];
  for (const page of [1, 2, 3]) {
    const { status, body } = await list(`q=pgx&page=${page}&perPage=25`);
    assert.equal(status, 200);
    assert.equal(body.data.total, 60);
    assert.equal(body.data.page, page);
    assert.equal(body.data.perPage, 25);
    assert.equal(body.data.items.length, page < 3 ? 25 : 10);
    seen.push(...body.data.items.map((item) => item.id));
  }
  assert.deepEqual(seen, expected, 'newest first, then id, with no repeats');
  // The same request twice gives the same page.
  const again = await list('q=pgx&page=2&perPage=25');
  assert.deepEqual(
    again.body.data.items.map((item) => item.id),
    expected.slice(25, 50),
  );
  // Oldest reverses the whole order.
  const oldest = await list('q=pgx&page=1&perPage=50&sort=oldest');
  assert.deepEqual(
    oldest.body.data.items.map((item) => item.id),
    [...expected].reverse().slice(0, 50),
  );
  // A shared link past the end lands on the last page.
  const past = await list('q=pgx&page=80&perPage=25');
  assert.equal(past.body.data.page, 3);
  assert.equal(past.body.data.items.length, 10);
  // Only 25, 50 or 100 per page, and a page from 1.
  for (const bad of ['perPage=30', 'perPage=abc', 'page=0', 'page=-1'])
    assert.equal((await list(`q=pgx&${bad}`)).status, 400, bad);
});

test('each filter: plan, page status (live, offline, suspended, no page yet), payouts, joined dates', async () => {
  const window = 'joinedFrom=2001-03-01&joinedTo=2001-03-31';
  const live = await account({
    createdAt: '2001-03-05T12:00:00Z',
    handle: 'flt_live',
    plan: 'pro',
    payouts: true,
  });
  const offline = await account({
    createdAt: '2001-03-06T12:00:00Z',
    handle: 'flt_offline',
    pageState: 'not_live',
  });
  const suspended = await account({
    createdAt: '2001-03-07T12:00:00Z',
    handle: 'flt_suspended',
    suspended: true,
  });
  const none = await account({ createdAt: '2001-03-08T12:00:00Z' });
  // Just outside the window on each side (Lagos days).
  await account({ createdAt: '2001-02-28T22:00:00Z', handle: 'flt_before' });
  await account({ createdAt: '2001-03-31T23:30:00Z', handle: 'flt_after' });

  const ids = async (filters) =>
    (await list(`${window}&${filters}`)).body.data.items.map((item) => item.id);
  assert.deepEqual(await ids('sort=oldest'), [
    live.userId,
    offline.userId,
    suspended.userId,
    none.userId,
  ]);
  assert.deepEqual(await ids('plan=pro'), [live.userId]);
  assert.deepEqual(await ids('plan=free&sort=oldest'), [
    offline.userId,
    suspended.userId,
    none.userId,
  ]);
  assert.deepEqual(await ids('pageStatus=live'), [live.userId]);
  assert.deepEqual(await ids('pageStatus=offline'), [offline.userId]);
  assert.deepEqual(await ids('pageStatus=suspended'), [suspended.userId]);
  assert.deepEqual(await ids('pageStatus=none'), [none.userId]);
  assert.deepEqual(await ids('payouts=set_up'), [live.userId]);
  assert.deepEqual(await ids('payouts=not_set_up&sort=oldest'), [
    offline.userId,
    suspended.userId,
    none.userId,
  ]);
  const narrow = await list(
    'joinedFrom=2001-03-06&joinedTo=2001-03-07&sort=oldest',
  );
  assert.deepEqual(
    narrow.body.data.items.map((item) => item.id),
    [offline.userId, suspended.userId],
  );

  const { body } = await list(`${window}&sort=oldest`);
  const [a, b, c, d] = body.data.items;
  assert.equal(a.pageStatus, 'live');
  assert.equal(a.plan, 'pro');
  assert.equal(a.payoutsSetUp, true);
  assert.equal(b.pageStatus, 'offline');
  assert.equal(c.pageStatus, 'suspended');
  assert.equal(d.pageStatus, 'none');
  assert.equal(d.handle, null);
  assert.equal(d.payoutsSetUp, false);
  for (const bad of [
    'plan=gold',
    'pageStatus=deleted',
    'payouts=maybe',
    'joinedFrom=yesterday',
    'sort=random',
    'unknown=1',
    'joinedFrom=2001-02-30',
    'page=1&page=2',
  ])
    assert.equal((await list(bad)).status, 400, bad);
});

test('search: name, handle, and an email only for private.view; masked emails in every list', async () => {
  const ada = await account({
    createdAt: '2003-01-01T12:00:00Z',
    handle: 'srch_ada',
    name: 'Adaeze Quillfeather',
    email: 'adaeze.q@example.com',
  });
  const byName = await list('q=quillfeather', searcher.cookie);
  assert.deepEqual(
    byName.body.data.items.map((item) => item.id),
    [ada.userId],
  );
  assert.deepEqual(
    handles((await list('q=%40srch_ad', searcher.cookie)).body),
    ['srch_ada'],
  );
  // The email finds the account only for private.view, and only as a whole address.
  assert.equal(
    (await list('q=adaeze.q%40example.com', searcher.cookie)).body.data.total,
    0,
  );
  const byEmail = await list('q=ADAEZE.Q%40example.com');
  assert.deepEqual(
    byEmail.body.data.items.map((item) => item.id),
    [ada.userId],
  );
  assert.equal((await list('q=adaeze.q%40exam')).body.data.total, 0);
  // Masked for both: the full address is a reveal with a reason.
  for (const cookie of [searcher.cookie, owner.cookie]) {
    const { body } = await list('q=quillfeather', cookie);
    assert.equal(body.data.items[0].email, 'a•••@example.com');
    assert.doesNotMatch(JSON.stringify(body), /adaeze\.q@/);
  }
});

test('the full email: private.view, a reason and a fresh code, audited with the reason', async () => {
  const one = await account({
    createdAt: '2003-02-01T12:00:00Z',
    handle: 'rvl_one',
    email: 'reveal.me@example.com',
  });
  const reveal = (cookie, body) =>
    fetch(`${stack.api}/v1/ops/users/${one.userId}/reveal`, {
      method: 'POST',
      headers: browserHeaders(cookie),
      body: JSON.stringify(body),
    });
  assert.equal((await reveal(searcher.cookie, { reason: REASON })).status, 403);
  assert.equal((await reveal(owner.cookie, { reason: 'short' })).status, 400);
  const shown = await reveal(owner.cookie, { reason: REASON });
  assert.equal(shown.status, 200);
  assert.deepEqual((await shown.json()).data, {
    email: 'reveal.me@example.com',
  });
  const [row] = await q(
    `SELECT staff_user_id, permission, subject_type, reason FROM audit_events
      WHERE action = 'people.email_revealed' AND subject_id = $1`,
    [one.userId],
  );
  assert.equal(row.staff_user_id, await idOf('+2348037781001'));
  assert.equal(row.permission, 'private.view');
  assert.equal(row.subject_type, 'user');
  assert.equal(row.reason, REASON);
  const missing = await fetch(
    `${stack.api}/v1/ops/users/${randomUUID()}/reveal`,
    {
      method: 'POST',
      headers: browserHeaders(owner.cookie),
      body: JSON.stringify({ reason: REASON }),
    },
  );
  assert.equal(missing.status, 404);
});

test('money is private.view only: totals omitted and the most-tips sort refused without it', async () => {
  const window = 'joinedFrom=2004-04-01&joinedTo=2004-04-30';
  const small = await account({
    createdAt: '2004-04-02T12:00:00Z',
    handle: 'mny_small',
    tipsMinor: [200000],
  });
  const big = await account({
    createdAt: '2004-04-01T12:00:00Z',
    handle: 'mny_big',
    tipsMinor: [500000, 300000],
  });
  const none = await account({
    createdAt: '2004-04-03T12:00:00Z',
    handle: 'mny_none',
  });
  const refused = await list(`${window}&sort=most_tips`, searcher.cookie);
  assert.equal(refused.status, 403);
  const masked = await list(window, searcher.cookie);
  assert.equal(masked.status, 200);
  for (const item of masked.body.data.items)
    assert.equal('tipsTotalMinor' in item, false);
  assert.doesNotMatch(JSON.stringify(masked.body), /800000|tipsTotal/);

  const ranked = await list(`${window}&sort=most_tips`);
  assert.equal(ranked.status, 200);
  assert.deepEqual(
    ranked.body.data.items.map((item) => [item.id, item.tipsTotalMinor]),
    [
      [big.userId, '800000'],
      [small.userId, '200000'],
      [none.userId, '0'],
    ],
  );
});

test('each item: business tag, avatar only for a live page, cover colour, joined and last active', async () => {
  const shop = await account({
    createdAt: '2005-05-05T12:00:00Z',
    handle: 'biz_owner',
    name: 'Biz Owner',
    business: { slug: `biz-${randomUUID().slice(0, 6)}`, name: 'Suya Spot' },
    lastSeenAt: '2026-11-10T09:00:00Z',
  });
  await q(
    `UPDATE profiles SET avatar_path = '/v1/avatars/x/1.webp', avatar_version = 1, cover_colour = 'ocean' WHERE id = $1`,
    [shop.profileId],
  );
  const bare = await account({
    createdAt: '2005-05-06T12:00:00Z',
    business: { slug: `biz-${randomUUID().slice(0, 6)}`, name: 'Bare Biz' },
  });
  const { body } = await list(
    'joinedFrom=2005-05-01&joinedTo=2005-05-31&sort=oldest',
    searcher.cookie,
  );
  const [a, b] = body.data.items;
  assert.equal(a.id, shop.userId);
  assert.equal(a.business, true);
  assert.equal(a.displayName, 'Biz Owner');
  assert.equal(a.avatarPath, '/v1/avatars/x/1.webp');
  assert.equal(a.coverColour, 'ocean');
  assert.equal(a.joinedAt, '2005-05-05T12:00:00.000Z');
  assert.equal(a.lastActiveAt, '2026-11-10T09:00:00.000Z');
  assert.equal(b.id, bare.userId);
  assert.equal(b.business, true);
  // No page: the business's name stands in, and nothing else of a page.
  assert.equal(b.displayName, 'Bare Biz');
  assert.equal(b.handle, null);
  assert.equal(b.avatarPath, null);
  assert.equal(b.lastActiveAt, null);
  // A page that isn't live keeps its photo out (the photo route serves live pages only).
  await q(`UPDATE profiles SET page_state = 'not_live' WHERE id = $1`, [
    shop.profileId,
  ]);
  const after = await list(
    'joinedFrom=2005-05-01&joinedTo=2005-05-31&sort=oldest',
    searcher.cookie,
  );
  assert.equal(after.body.data.items[0].avatarPath, null);
});

test('each list is audited without what was typed; search.view is needed; others learn nothing', async () => {
  const before = (
    await q(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'people.listed'`,
    )
  )[0].n;
  assert.equal(
    (await list('q=secretwords&page=1', searcher.cookie)).status,
    200,
  );
  const rows = await q(
    `SELECT staff_user_id, permission, subject_type, subject_id FROM audit_events
      WHERE action = 'people.listed' ORDER BY seq DESC`,
  );
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].staff_user_id, await idOf('+2348037781002'));
  assert.equal(rows[0].permission, 'search.view');
  assert.equal(rows[0].subject_type, 'people');
  assert.doesNotMatch(rows[0].subject_id, /secretwords/);
  assert.match(rows[0].subject_id, /11 characters/);

  assert.equal((await list('page=1', plain.cookie)).status, 403);
  const recipient = await signIn(stack.api, '+2348000000077');
  assert.equal((await list('page=1', recipient.cookie)).status, 404);
  assert.equal((await list('page=1', '')).status, 404);
});

test('staff are listed like anyone else', async () => {
  const staffId = await idOf('+2348037781002');
  let found = false;
  for (let page = 1; page <= 20 && !found; page += 1) {
    const { body } = await list(`page=${page}&perPage=100`);
    found = body.data.items.some((item) => item.id === staffId);
    if (body.data.items.length < 100) break;
  }
  assert.ok(found);
});

test('a few hundred accounts: a 100-row page with totals and the heaviest sort stays quick', async () => {
  await q(
    `INSERT INTO users (id, email, created_at)
     SELECT gen_random_uuid(), 'bulk' || g || '@example.com', now() - g * interval '1 minute'
       FROM generate_series(1, 300) g`,
  );
  await q(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state)
     SELECT gen_random_uuid(), u.id, 'bulk' || substr(u.id::text, 1, 8), 'bulk' || substr(u.id::text, 1, 8), 'Bulk ' || substr(u.id::text, 1, 8), 'live'
       FROM users u WHERE u.email LIKE 'bulk%@example.com'`,
  );
  // Warm once, then time the slowest shapes.
  await list('perPage=100&sort=most_tips');
  for (const query of [
    'perPage=100&sort=most_tips',
    'perPage=100&sort=name&page=3',
    'perPage=100&payouts=not_set_up&pageStatus=live',
  ]) {
    const started = performance.now();
    const { status, body } = await list(query);
    const took = performance.now() - started;
    assert.equal(status, 200, query);
    assert.ok(body.data.total >= 300, query);
    assert.ok(took < 1500, `${query} took ${Math.round(took)} ms`);
  }
});
