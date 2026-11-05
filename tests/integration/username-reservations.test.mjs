import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { RESERVED_HANDLES } from '../../packages/domain/dist/index.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// Staff reservations of usernames (docs/superpowers/specs/2026-11-03-username-reservation-design.md).
// The database guard comes first: a release that predates reservations (after a rollback) must not
// hand a reserved name out, so the refusal lives in triggers as well as in the application. Every
// test uses its own names, so they share one reset database and one stack.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

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
    },
  });
  staff = await opsSignIn(stack.api, database.db, '+2348031280099');
  // A staff address, so the list can show it masked.
  await database.pool.query(
    `UPDATE users SET email = 'ops.lead@example.com', email_verified_at = now() WHERE phone_e164 = '+2348031280099'`,
  );
});
after(async () => {
  await stack.stop();
  await database.close();
});

const UNIQUE_VIOLATION = '23505';

async function refusedWith(code, promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

const reserve = (key) =>
  database.pool.query(
    `INSERT INTO handle_reservations (id, handle_lower, source, reason, reserved_at)
     VALUES ($1, $2, 'staff', 'brand name', now()) RETURNING id`,
    [randomUUID(), key],
  );

const insertPage = (handle) =>
  database.pool.query(
    `INSERT INTO profiles (id, handle, handle_lower, display_name)
     VALUES ($1, $2, lower($2), 'Page') RETURNING id`,
    [randomUUID(), handle],
  );

test('the trigger refuses a claim on a reserved name', async () => {
  await reserve('trg_claim');
  await refusedWith(UNIQUE_VIOLATION, insertPage('trg_claim'));
  const { rowCount } = await database.pool.query(
    `SELECT 1 FROM profiles WHERE handle_lower = 'trg_claim'`,
  );
  assert.equal(rowCount, 0);
});

test('the trigger refuses a rename onto a reserved name', async () => {
  const { rows } = await insertPage('trg_renamer');
  await reserve('trg_rename');
  await refusedWith(
    UNIQUE_VIOLATION,
    database.pool.query(
      `UPDATE profiles SET handle = 'trg_rename', handle_lower = 'trg_rename' WHERE id = $1`,
      [rows[0].id],
    ),
  );
  // A change that does not touch the handle is left alone.
  await database.pool.query(
    `UPDATE profiles SET display_name = 'Kemi' WHERE id = $1`,
    [rows[0].id],
  );
});

test('the trigger refuses an alias insert on a reserved name', async () => {
  const { rows } = await insertPage('trg_aliaser');
  await reserve('trg_alias');
  await refusedWith(
    UNIQUE_VIOLATION,
    database.pool.query(
      `INSERT INTO handle_aliases (handle_lower, profile_id) VALUES ('trg_alias', $1)`,
      [rows[0].id],
    ),
  );
});

test('a reservation is refused while a page or an old username holds the name', async () => {
  const { rows } = await insertPage('trg_held');
  await refusedWith(UNIQUE_VIOLATION, reserve('trg_held'));
  await database.pool.query(
    `INSERT INTO handle_aliases (handle_lower, profile_id) VALUES ('trg_held_old', $1)`,
    [rows[0].id],
  );
  await refusedWith(UNIQUE_VIOLATION, reserve('trg_held_old'));
});

test('a released reservation no longer blocks a claim', async () => {
  const { rows: user } = await database.pool.query(
    `INSERT INTO users (id) VALUES ($1) RETURNING id`,
    [randomUUID()],
  );
  await database.pool.query(
    `INSERT INTO handle_reservations
       (id, handle_lower, source, reason, reserved_at, released_at, released_by, release_reason)
     VALUES ($1, 'trg_released', 'staff', 'brand name', now(), now(), $2, 'no longer needed')`,
    [randomUUID(), user[0].id],
  );
  await insertPage('trg_released');
});

test('a release must say who and why', async () => {
  await refusedWith(
    '23514',
    database.pool.query(
      `INSERT INTO handle_reservations (id, handle_lower, source, reason, reserved_at, released_at)
       VALUES ($1, 'trg_who', 'staff', 'brand name', now(), now())`,
      [randomUUID()],
    ),
  );
});

test('two active reservations of one key cannot exist', async () => {
  await reserve('trg_twice');
  await refusedWith(UNIQUE_VIOLATION, reserve('trg_twice'));
});

// The routes: reserve, release, check and list (permission usernames.manage, fresh code).
const STAFF_EMAIL = 'ops.lead@example.com';
const REASON = 'A telecoms brand asked us to hold it';
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
const reserveName = (name, reason = REASON) =>
  call('POST', '/v1/ops/usernames', staff.cookie, { name, reason });
const releaseName = (name, reason = 'The brand no longer needs it') =>
  call(
    'POST',
    `/v1/ops/usernames/${encodeURIComponent(name)}/release`,
    staff.cookie,
    {
      reason,
    },
  );
const checkName = async (name) =>
  json(
    await call(
      'GET',
      `/v1/ops/usernames/check/${encodeURIComponent(name)}`,
      staff.cookie,
    ),
  );
const availability = async (handle) =>
  (await json(await call('GET', `/v1/handles/${handle}/availability`))).status;
let phones = 0;
const nextPhone = () => `+23480312801${String(phones++).padStart(2, '0')}`;
const claim = async (handle, cookie) =>
  call(
    'POST',
    '/v1/me/page',
    cookie ?? (await signIn(stack.api, nextPhone())).cookie,
    {
      handle,
    },
  );

test('reserve, then sign-up refuses it, then release frees it', async () => {
  const reserved = await reserveName('Res_Flow');
  assert.equal(reserved.status, 201);
  const row = await json(reserved);
  assert.equal(row.name, 'res_flow');
  assert.equal(row.source, 'staff');
  assert.equal(row.reason, REASON);
  assert.equal(row.takeBackId, null);
  assert.ok(row.reservedBy && row.reservedBy !== STAFF_EMAIL, 'masked');
  assert.ok(!Number.isNaN(Date.parse(row.reservedAt)));

  assert.equal(await availability('res_flow'), 'reserved');
  const refused = await claim('res_flow');
  assert.equal(refused.status, 409);
  assert.equal(await code(refused), 'HANDLE_TAKEN');

  const released = await releaseName('RES_FLOW');
  assert.equal(released.status, 200);
  assert.deepEqual(await json(released), { name: 'res_flow' });
  assert.equal(await availability('res_flow'), 'available');
  assert.equal((await claim('res_flow')).status, 201);
  // Released rows stay as history.
  const { rows } = await database.pool.query(
    `SELECT released_by IS NOT NULL AS by, release_reason FROM handle_reservations WHERE handle_lower = 'res_flow'`,
  );
  assert.deepEqual(rows, [
    { by: true, release_reason: 'The brand no longer needs it' },
  ]);
});

test('a built-in name is refused with USERNAME_BUILT_IN, and can never be released', async () => {
  for (const name of ['admin', 'PRO', 'how-it-works', 'me']) {
    const reserve = await reserveName(name);
    assert.equal(reserve.status, 409, name);
    assert.equal(await code(reserve), 'USERNAME_BUILT_IN', name);
    const release = await releaseName(name);
    assert.equal(release.status, 409, name);
    assert.equal(await code(release), 'USERNAME_BUILT_IN', name);
  }
  assert.equal((await checkName('Admin')).state, 'built_in');
  const { rowCount } = await database.pool.query(
    `SELECT 1 FROM handle_reservations WHERE handle_lower IN ('admin', 'pro', 'how_it_works', 'me')`,
  );
  assert.equal(rowCount, 0);
});

test('a second reservation differing by case or hyphen is refused and shown the first', async () => {
  const first = await json(await reserveName('how_it_works2'));
  for (const again of ['HOW-IT-WORKS2', 'How_It_Works2', 'how-it_works2']) {
    const refused = await reserveName(again);
    assert.equal(refused.status, 409, again);
    assert.equal(await code(refused), 'USERNAME_RESERVED', again);
  }
  // The refusal carries no row (errors never echo data); the check shows the one that holds it.
  const check = await checkName('How-It-Works2');
  assert.equal(check.state, 'reserved');
  assert.equal(check.reservation.id, first.id);
  assert.equal(check.name, 'how_it_works2');
});

test('a name a page holds, as its username or an old one, is refused with USERNAME_HELD_BY_PAGE', async () => {
  const { rows } = await insertPage('held_now');
  await database.pool.query(
    `INSERT INTO handle_aliases (handle_lower, profile_id) VALUES ('held_before', $1)`,
    [rows[0].id],
  );
  for (const name of ['held_now', 'HELD-BEFORE']) {
    const refused = await reserveName(name);
    assert.equal(refused.status, 409, name);
    assert.equal(await code(refused), 'USERNAME_HELD_BY_PAGE', name);
  }
  const current = await checkName('held_now');
  assert.equal(current.state, 'page');
  assert.equal(current.kind, 'current');
  assert.equal(current.page.handle, 'held_now');
  const old = await checkName('held_before');
  assert.equal(old.state, 'page');
  assert.equal(old.kind, 'old');
  assert.equal(old.page.profileId, rows[0].id);
});

test('a name in a 90-day deletion hold can be reserved, and check shows heldUntil', async () => {
  const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await database.pool.query(
    `INSERT INTO handle_holds (handle_lower, until) VALUES ('held_gone', $1)`,
    [until],
  );
  assert.deepEqual(await checkName('held_gone'), {
    name: 'held_gone',
    state: 'free',
    heldUntil: until.toISOString(),
  });
  assert.deepEqual(await checkName('never_seen'), {
    name: 'never_seen',
    state: 'free',
    heldUntil: null,
  });
  assert.equal((await reserveName('held_gone')).status, 201);
  assert.equal((await checkName('held_gone')).state, 'reserved');
});

test('a name that can never be a handle is invalid, and is not reserved', async () => {
  assert.deepEqual(await checkName('no!'), { name: 'no!', state: 'invalid' });
  const refused = await reserveName('no!');
  assert.equal(refused.status, 400);
  const release = await releaseName('never_reserved');
  assert.equal(release.status, 404);
  assert.equal(await code(release), 'USERNAME_NOT_RESERVED');
});

test('a reason is required and checked like every staff reason', async () => {
  for (const reason of ['short', `${REASON} [change: {}]`]) {
    const refused = await reserveName('reasoned', reason);
    assert.equal(refused.status, 400, reason);
  }
  assert.equal((await checkName('reasoned')).state, 'free');
});

test('two reservations of one name at once: one wins, the other is told it is reserved', async () => {
  for (let i = 0; i < 5; i++) {
    const answers = await Promise.all([
      reserveName(`twice_${i}`),
      reserveName(`TWICE-${i}`),
    ]);
    const statuses = answers.map((a) => a.status).sort();
    assert.deepEqual(statuses, [201, 409], `round ${i}`);
    const loser = answers.find((a) => a.status === 409);
    assert.equal(await code(loser), 'USERNAME_RESERVED');
  }
});

test('reserve against claim at once: exactly one wins', async () => {
  for (let i = 0; i < 5; i++) {
    const name = `contest_${i}`;
    const { cookie } = await signIn(stack.api, nextPhone());
    const [reserved, claimed] = await Promise.all([
      reserveName(name),
      claim(name, cookie),
    ]);
    const won = [reserved.status, claimed.status].filter((s) => s === 201);
    assert.equal(
      won.length,
      1,
      `round ${i}: ${reserved.status} ${claimed.status}`,
    );
    if (reserved.status === 201) {
      assert.equal(claimed.status, 409);
      assert.equal(await code(claimed), 'HANDLE_TAKEN');
    } else {
      assert.equal(reserved.status, 409);
      assert.equal(await code(reserved), 'USERNAME_HELD_BY_PAGE');
    }
    const { rows } = await database.pool.query(
      `SELECT (SELECT count(*)::int FROM profiles WHERE handle_lower = $1) AS pages,
              (SELECT count(*)::int FROM handle_reservations WHERE handle_lower = $1 AND released_at IS NULL) AS reservations`,
      [name],
    );
    assert.equal(rows[0].pages + rows[0].reservations, 1, `round ${i}`);
  }
});

test('reserve and release are audited with the reason and the key', async () => {
  await reserveName('Audit-Me');
  await releaseName('audit_me', 'Reserved by mistake, freeing it');
  const { rows } = await database.pool.query(
    `SELECT a.action, a.permission, a.subject_type, a.subject_id, a.reason, u.phone_e164
       FROM audit_events a JOIN users u ON u.id = a.staff_user_id
      WHERE a.subject_id = 'audit_me' ORDER BY a.seq`,
  );
  assert.deepEqual(rows, [
    {
      action: 'username.reserved',
      permission: 'usernames.manage',
      subject_type: 'username',
      subject_id: 'audit_me',
      reason: REASON,
      phone_e164: '+2348031280099',
    },
    {
      action: 'username.released',
      permission: 'usernames.manage',
      subject_type: 'username',
      subject_id: 'audit_me',
      reason: 'Reserved by mistake, freeing it',
      phone_e164: '+2348031280099',
    },
  ]);
  // A refused attempt changes nothing and writes nothing.
  await reserveName('admin');
  const { rowCount } = await database.pool.query(
    `SELECT 1 FROM audit_events WHERE subject_id = 'admin' AND action LIKE 'username.%'`,
  );
  assert.equal(rowCount, 0);
});

test('check names a page by public-level fields only', async () => {
  const phone = nextPhone();
  const { cookie } = await signIn(stack.api, phone);
  assert.equal((await claim('private_page', cookie)).status, 201);
  await database.pool.query(
    `UPDATE users SET email = 'page.owner@example.com', email_verified_at = now() WHERE phone_e164 = $1`,
    [phone],
  );
  const response = await call(
    'GET',
    '/v1/ops/usernames/check/private_page',
    staff.cookie,
  );
  const text = await response.text();
  for (const secret of [
    'page.owner',
    'example.com',
    phone,
    phone.slice(1),
    'balance',
  ])
    assert.ok(!text.includes(secret), secret);
  const { data } = JSON.parse(text);
  assert.equal(data.state, 'page');
  for (const key of Object.keys(data.page))
    assert.ok(
      [
        'profileId',
        'userId',
        'handle',
        'displayName',
        'plan',
        'pageState',
        'suspended',
        'handleChanges',
        'images',
      ].includes(key),
      key,
    );
});

test('the list shows active reservations by prefix and source, and the built-in list', async () => {
  await reserveName('listed_one');
  await reserveName('listed_two');
  await reserveName('unlisted_x');
  await reserveName('listed_gone');
  await releaseName('listed_gone');
  const list = await json(
    await call('GET', '/v1/ops/usernames?q=LISTED', staff.cookie),
  );
  assert.deepEqual(list.reservations.map((r) => r.name).sort(), [
    'listed_one',
    'listed_two',
  ]);
  assert.deepEqual(list.builtIn, [...RESERVED_HANDLES]);
  // '_' in a prefix matches itself, not any one character.
  const underscore = await json(
    await call('GET', '/v1/ops/usernames?q=listed_t', staff.cookie),
  );
  assert.deepEqual(
    underscore.reservations.map((r) => r.name),
    ['listed_two'],
  );
  const takeBacks = await json(
    await call('GET', '/v1/ops/usernames?state=take_back', staff.cookie),
  );
  assert.deepEqual(takeBacks.reservations, []);
  const refused = await call(
    'GET',
    '/v1/ops/usernames?state=other',
    staff.cookie,
  );
  assert.equal(refused.status, 400);
});
