import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
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

// Username handover routes (owner's approval, 18 Nov 2026). Staff make, show once and cancel a
// claim link, and give a reserved name to an account they find (usernames.manage, a fresh code,
// audited). The person with the link previews it with no sign-in and claims it signed in; both are
// rate-limited, and the code never reaches a log, the audit log or analytics.
const spans = new InMemorySpanExporter();
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: spans,
});

const CLAIM_LIMIT = 40;
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
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
      RATE_LIMIT_USERNAME_CLAIMS_PER_HOUR: String(CLAIM_LIMIT),
    },
  });
  staff = await opsSignIn(stack.api, database.db, '+2348031290099');
});
after(async () => {
  await stack.stop();
  await database.close();
});

const REASON = 'The brand proved it owns this name';
const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    redirect: 'manual',
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response) => (await response.json()).data;
const code = async (response) => (await response.json()).error.code;
const q = async (text, values) =>
  (await database.pool.query(text, values)).rows;
let phones = 0;
const nextPhone = () => `+23480312902${String(phones++).padStart(2, '0')}`;

const reserve = (name) =>
  call('POST', '/v1/ops/usernames', staff.cookie, { name, reason: REASON });
const makeLink = (name, reason = REASON) =>
  call('POST', `/v1/ops/usernames/${name}/handover-link`, staff.cookie, {
    reason,
  });
const cancelLink = (name, reason = 'The brand asked us to stop') =>
  call('POST', `/v1/ops/usernames/${name}/handover-link/cancel`, staff.cookie, {
    reason,
  });
const preview = (claimCode) =>
  call('POST', '/v1/handles/claim-link/preview', undefined, {
    code: claimCode,
  });
const claim = (claimCode, cookie) =>
  call('POST', '/v1/me/username-claim', cookie, { code: claimCode });
const codeIn = (path) => path.split('#claim=')[1];

async function linkFor(name) {
  assert.equal((await reserve(name)).status, 201);
  const made = await makeLink(name);
  assert.equal(made.status, 201);
  return json(made);
}

test('staff make a claim link: shown once, stored as a hash, the check shows it without the code', async () => {
  const made = await linkFor('api_brand_a');
  assert.match(made.path, /^\/sign-up\/claim#claim=[A-Z2-7]{24}$/);
  assert.equal(made.link.name, 'api_brand_a');
  const claimCode = codeIn(made.path);
  const check = await call(
    'GET',
    '/v1/ops/usernames/check/api_brand_a',
    staff.cookie,
  );
  const text = await check.text();
  assert.ok(!text.includes(claimCode));
  assert.equal(JSON.parse(text).data.handoverLink.id, made.link.id);
  // Anyone holding it sees the name, with no sign-in.
  const seen = await preview(claimCode);
  assert.equal(seen.status, 200);
  assert.equal(seen.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await json(seen), {
    state: 'open',
    name: 'api_brand_a',
    expiresAt: made.link.expiresAt,
  });
  const unknown = await preview('B'.repeat(24));
  assert.deepEqual(await json(unknown), { state: 'invalid' });
  assert.equal((await preview('nope')).status, 400);
});

test('a signed-in person with a page claims through the link; the old username redirects', async () => {
  const made = await linkFor('api_brand_b');
  const { cookie } = await signIn(stack.api, nextPhone());
  assert.equal(
    (await call('POST', '/v1/me/page', cookie, { handle: 'api_kemi_b' }))
      .status,
    201,
  );
  // CSRF: a cross-site form can't claim.
  const forged = await fetch(`${stack.api}/v1/me/username-claim`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ code: codeIn(made.path) }),
  });
  assert.equal(forged.status, 403);
  const claimed = await claim(codeIn(made.path), cookie);
  assert.equal(claimed.status, 200);
  assert.deepEqual(await json(claimed), {
    handle: 'api_brand_b',
    previous: 'api_kemi_b',
    created: false,
  });
  // A page that isn't live reveals nothing, as before; live, the old username redirects.
  await q(
    `UPDATE profiles SET page_state = 'live' WHERE handle_lower = 'api_brand_b'`,
  );
  const moved = await call('GET', '/v1/profiles/api_kemi_b');
  assert.equal(moved.status, 308);
  assert.deepEqual(await json(moved), { movedTo: 'api_brand_b' });
  // Used: a second claim is refused, and the preview says so.
  const again = await claim(
    codeIn(made.path),
    (await signIn(stack.api, nextPhone())).cookie,
  );
  assert.equal(again.status, 404);
  assert.equal(await code(again), 'CLAIM_LINK_INVALID');
  assert.deepEqual(await json(await preview(codeIn(made.path))), {
    state: 'used',
  });
});

test('an account with no page claims the name and gets a page', async () => {
  const made = await linkFor('api_brand_c');
  const { cookie } = await signIn(stack.api, nextPhone());
  assert.equal((await call('GET', '/v1/me/profile', cookie)).status, 404);
  const claimed = await claim(codeIn(made.path), cookie);
  assert.deepEqual(await json(claimed), {
    handle: 'api_brand_c',
    previous: null,
    created: true,
  });
  assert.equal(
    (await json(await call('GET', '/v1/me/profile', cookie))).handle,
    'api_brand_c',
  );
  assert.equal(
    (await claim(codeIn(made.path))).status,
    401,
    'signed out: no claim',
  );
});

test('a new link cancels the old; staff cancel a link; expired links say so', async () => {
  const first = await linkFor('api_brand_d');
  const second = await json(
    await makeLink('api_brand_d', 'The first link went astray'),
  );
  assert.deepEqual(await json(await preview(codeIn(first.path))), {
    state: 'cancelled',
  });
  const cancelled = await cancelLink('api_brand_d');
  assert.equal(cancelled.status, 200);
  assert.equal((await json(cancelled)).id, second.link.id);
  assert.deepEqual(await json(await preview(codeIn(second.path))), {
    state: 'cancelled',
  });
  const none = await cancelLink('api_brand_d');
  assert.equal(none.status, 404);
  assert.equal(await code(none), 'HANDOVER_LINK_NOT_FOUND');
  const third = await json(await makeLink('api_brand_d'));
  await q(
    `UPDATE handle_handover_links SET created_at = now() - interval '15 days', expires_at = now() - interval '1 day' WHERE id = $1`,
    [third.link.id],
  );
  assert.deepEqual(await json(await preview(codeIn(third.path))), {
    state: 'expired',
  });
  const late = await claim(
    codeIn(third.path),
    (await signIn(stack.api, nextPhone())).cookie,
  );
  assert.equal(await code(late), 'CLAIM_LINK_INVALID');
  assert.equal(
    (
      await q(
        `SELECT 1 FROM handle_reservations WHERE handle_lower = 'api_brand_d' AND released_at IS NULL`,
      )
    ).length,
    1,
  );
});

test('built-in and unreserved names are refused', async () => {
  const builtIn = await makeLink('admin');
  assert.equal(builtIn.status, 409);
  assert.equal(await code(builtIn), 'USERNAME_BUILT_IN');
  const unreserved = await makeLink('api_nobody');
  assert.equal(unreserved.status, 404);
  assert.equal(await code(unreserved), 'USERNAME_NOT_RESERVED');
  const short = await makeLink('api_nobody', 'short');
  assert.equal(short.status, 400);
});

test('staff find an account by username or email and give it the name, audited with the reason', async () => {
  await reserve('api_brand_e');
  const phone = nextPhone();
  const { cookie } = await signIn(stack.api, phone);
  await call('POST', '/v1/me/page', cookie, { handle: 'api_kemi_e' });
  await q(
    `UPDATE users SET email = 'kemi.e@example.com', email_verified_at = now() WHERE phone_e164 = $1`,
    [phone],
  );
  const find = (query) =>
    call('POST', '/v1/ops/usernames/handover-accounts', staff.cookie, {
      query,
    });
  const byEmail = await find('Kemi.E@example.com');
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.headers.get('cache-control'), 'private, no-store');
  const text = await byEmail.text();
  for (const secret of ['kemi.e', 'example.com', phone, phone.slice(1)])
    assert.ok(!text.includes(secret), secret);
  const [account] = JSON.parse(text).data;
  assert.equal(account.foundBy, 'email');
  assert.equal(account.page.handle, 'api_kemi_e');
  assert.equal(account.liveCheckoutListed, false);
  const [byName] = await json(await find('@api_kemi_e'));
  assert.equal(byName.userId, account.userId);
  assert.deepEqual(await json(await find('kemi.e@')), []);
  // What staff typed is audited by its length only: it could be an email address.
  const lookups = await q(
    `SELECT subject_id FROM audit_events WHERE action = 'username.account_lookup'`,
  );
  assert.ok(lookups.length >= 3);
  assert.ok(lookups.every((row) => /^\d+ characters$/.test(row.subject_id)));

  const given = await call(
    'POST',
    '/v1/ops/usernames/api_brand_e/assign',
    staff.cookie,
    {
      userId: account.userId,
      reason: 'Their brand team asked by email on 18 Nov',
    },
  );
  assert.equal(given.status, 200);
  assert.deepEqual(await json(given), {
    name: 'api_brand_e',
    handle: 'api_brand_e',
    previous: 'api_kemi_e',
    profileId: account.page.profileId,
    created: false,
  });
  assert.equal(
    (await json(await call('GET', '/v1/me/profile', cookie))).handle,
    'api_brand_e',
  );
  const [audit] = await q(
    `SELECT reason, permission FROM audit_events WHERE action = 'username.assigned' AND subject_id = 'api_brand_e'`,
  );
  assert.equal(audit.permission, 'usernames.manage');
  assert.ok(
    audit.reason.startsWith('Their brand team asked by email on 18 Nov'),
  );
  const twice = await call(
    'POST',
    '/v1/ops/usernames/api_brand_e/assign',
    staff.cookie,
    {
      userId: account.userId,
      reason: 'Their brand team asked by email on 18 Nov',
    },
  );
  assert.equal(await code(twice), 'USERNAME_NOT_RESERVED');
});

const routes = [
  ['POST', '/v1/ops/usernames/api_perm/handover-link', { reason: REASON }],
  [
    'POST',
    '/v1/ops/usernames/api_perm/handover-link/cancel',
    { reason: REASON },
  ],
  ['POST', '/v1/ops/usernames/handover-accounts', { query: 'api_perm' }],
  [
    'POST',
    '/v1/ops/usernames/api_perm/assign',
    { userId: '00000000-0000-4000-8000-000000000001', reason: REASON },
  ],
];

test('the handover routes need usernames.manage and a fresh code', async () => {
  const phone = '+2348031290098';
  const other = await opsSignIn(stack.api, database.db, phone);
  await q(
    `INSERT INTO roles (id, name) VALUES ('no_usernames', 'no_usernames') ON CONFLICT DO NOTHING`,
  );
  await q(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('no_usernames', 'search.view') ON CONFLICT DO NOTHING`,
  );
  await q(
    `UPDATE staff SET role_id = 'no_usernames' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)`,
    [phone],
  );
  for (const [method, path, body] of routes) {
    const response = await call(method, path, other.cookie, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(await code(response), 'FORBIDDEN', `${method} ${path}`);
  }
  await q(`UPDATE ops_sessions SET last_totp_at = now() - interval '6 minutes'
            WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348031290099')`);
  for (const [method, path, body] of routes) {
    const response = await call(method, path, staff.cookie, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(
      await code(response),
      'FRESH_CODE_REQUIRED',
      `${method} ${path}`,
    );
  }
  await q(`UPDATE ops_sessions SET last_totp_at = now()`);
  // Not staff at all: the admin area hides itself.
  const { cookie } = await signIn(stack.api, nextPhone());
  for (const [method, path, body] of routes)
    assert.equal(
      (await call(method, path, cookie, body)).status,
      404,
      `${method} ${path}`,
    );
});

test('the code never reaches a log, the audit log, analytics or a trace', async () => {
  const made = await linkFor('api_brand_f');
  const claimCode = codeIn(made.path);
  await preview(claimCode);
  await claim(claimCode, (await signIn(stack.api, nextPhone())).cookie);
  assert.equal(JSON.stringify(stack.logs).includes(claimCode), false, 'logs');
  const stored = await q(
    `SELECT row_to_json(a)::text AS t FROM audit_events a
     UNION ALL SELECT row_to_json(e)::text FROM analytics_events e
     UNION ALL SELECT row_to_json(l)::text FROM handle_handover_links l`,
  );
  assert.ok(stored.length > 0);
  for (const row of stored)
    assert.equal(row.t.includes(claimCode), false, row.t.slice(0, 80));
  const traced = JSON.stringify(
    spans.getFinishedSpans().map((span) => span.attributes),
  );
  assert.equal(traced.includes(claimCode), false, 'spans');
});

// Last: it uses up this address's allowance.
test('previews and claims are rate-limited per address', async () => {
  const made = await linkFor('api_brand_z');
  let limited = null;
  for (let i = 0; i <= CLAIM_LIMIT && !limited; i++) {
    const response = await preview('C'.repeat(24));
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, 'a preview was limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const { cookie } = await signIn(stack.api, nextPhone());
  const refused = await claim(codeIn(made.path), cookie);
  assert.equal(refused.status, 429);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM handle_reservations WHERE handle_lower = 'api_brand_z' AND released_at IS NULL`,
      )
    ).length,
    1,
  );
});
