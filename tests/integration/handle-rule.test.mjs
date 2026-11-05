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

// The handle rule: a Free page keeps the handle it claimed; a Pro page gets 3 changes in total,
// counted on the server, and staff can allow more. Old handles keep leading to the page.
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
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
  staff = await opsSignIn(stack.api, database.db, '+2348031270099');
});
after(async () => {
  await stack.stop();
  await database.close();
});

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

async function livePage(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  assert.equal(
    (await call('POST', '/v1/me/page', cookie, { handle })).status,
    201,
  );
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  return cookie;
}

async function setPlan(handle, plan) {
  const page = await json(
    await call('GET', `/v1/ops/pages/${handle}`, staff.cookie),
  );
  const response = await call(
    'POST',
    `/v1/ops/pages/${page.profileId}/plan`,
    staff.cookie,
    { plan, reason: 'Testing the handle rule' },
  );
  assert.equal(response.status, 200);
}

async function proPage(phone, handle) {
  const cookie = await livePage(phone, handle);
  await setPlan(handle, 'pro');
  return cookie;
}

const rename = (cookie, handle) =>
  call('PUT', '/v1/me/handle', cookie, { handle });
const mine = async (cookie) =>
  json(await call('GET', '/v1/me/profile', cookie));
const grant = (handle, body) =>
  call('POST', `/v1/ops/pages/${handle}/handle-changes`, staff.cookie, body);

test('a Free page cannot change its handle', async () => {
  const cookie = await livePage('+2348031270001', 'free_keeps');
  const refused = await rename(cookie, 'free_moves');
  assert.equal(refused.status, 403);
  assert.equal(await code(refused), 'HANDLE_CHANGE_PRO_REQUIRED');
  const profile = await mine(cookie);
  assert.equal(profile.handle, 'free_keeps');
  assert.deepEqual(profile.handleChanges, { used: 0, allowed: 3 });
  assert.deepEqual(profile.previousHandles, []);
  // Nothing was taken: the handle it asked for is still anyone's.
  const status = await call('GET', '/v1/handles/free_moves/availability');
  assert.equal((await json(status)).status, 'available');
});

test('a Pro page changes three times, then is refused', async () => {
  const cookie = await proPage('+2348031270002', 'three_0');
  for (const [used, handle] of [
    [1, 'three_1'],
    [2, 'three_2'],
    [3, 'three_3'],
  ]) {
    const changed = await rename(cookie, handle);
    assert.equal(changed.status, 200, handle);
    const data = await json(changed);
    assert.equal(data.handle, handle);
    assert.deepEqual(data.handleChanges, { used, allowed: 3 });
  }
  const fourth = await rename(cookie, 'three_4');
  assert.equal(fourth.status, 409);
  assert.equal(await code(fourth), 'HANDLE_CHANGE_LIMIT');
  const profile = await mine(cookie);
  assert.equal(profile.handle, 'three_3');
  assert.deepEqual(profile.handleChanges, { used: 3, allowed: 3 });
});

test('a refused change uses up nothing', async () => {
  const cookie = await proPage('+2348031270003', 'refuse_me');
  await livePage('+2348031270004', 'refuse_other');
  assert.equal(
    await code(await rename(cookie, 'refuse_other')),
    'HANDLE_TAKEN',
  );
  assert.equal(await code(await rename(cookie, 'admin')), 'HANDLE_TAKEN');
  assert.equal((await rename(cookie, 'no spaces!')).status, 400);
  assert.deepEqual((await mine(cookie)).handleChanges, { used: 0, allowed: 3 });
});

test('switching back to an old handle counts', async () => {
  const cookie = await proPage('+2348031270005', 'back_a');
  assert.equal((await rename(cookie, 'back_b')).status, 200);
  assert.equal((await rename(cookie, 'back_a')).status, 200);
  assert.deepEqual((await mine(cookie)).handleChanges, { used: 2, allowed: 3 });
  assert.equal((await rename(cookie, 'back_b')).status, 200);
  const refused = await rename(cookie, 'back_a');
  assert.equal(refused.status, 409);
  assert.equal(await code(refused), 'HANDLE_CHANGE_LIMIT');
  assert.equal((await mine(cookie)).handle, 'back_b');
});

test('an owner who renamed away from a reserved name can rename back to it', async () => {
  const cookie = await proPage('+2348031270091', 'was_zainab');
  // A page that predates the reservation (a demo page, or one claimed before it): set directly.
  await database.db.execute(
    "update profiles set handle = 'zainab', handle_lower = 'zainab' where handle_lower = 'was_zainab'",
  );
  assert.equal((await rename(cookie, 'zainab_now')).status, 200);
  // Someone else still cannot take the reserved name, but its owner can come back to it.
  const other = await livePage('+2348031270092', 'not_zainab');
  assert.equal(
    await code(await rename(other, 'zainab')),
    'HANDLE_CHANGE_PRO_REQUIRED',
  );
  assert.equal((await rename(cookie, 'zainab')).status, 200);
  assert.equal((await mine(cookie)).handle, 'zainab');
});

test('a Pro page cannot take a reserved name that is not its own old handle', async () => {
  const cookie = await proPage('+2348031270093', 'wants_reserved');
  const refused = await rename(cookie, 'tobi');
  assert.equal(refused.status, 409);
  assert.equal(await code(refused), 'HANDLE_TAKEN');
  assert.equal((await mine(cookie)).handle, 'wants_reserved');
});

test('a change of case alone changes and counts nothing', async () => {
  const pro = await proPage('+2348031270006', 'case_pro');
  const cased = await rename(pro, 'Case_PRO');
  assert.equal(cased.status, 200);
  const data = await json(cased);
  assert.equal(data.handle, 'case_pro');
  assert.deepEqual(data.handleChanges, { used: 0, allowed: 3 });
  assert.deepEqual(data.previousHandles, []);
  // Not a change, so a Free page isn't refused for it either.
  const free = await livePage('+2348031270007', 'case_free');
  assert.equal((await rename(free, 'CASE_free')).status, 200);
});

test('old handles keep leading to the page and stay unclaimable', async () => {
  const cookie = await proPage('+2348031270008', 'keep_a');
  // More old handles than the old limit of 5 would have allowed, through staff's allowance.
  assert.equal(
    (
      await grant('keep_a', {
        extra: 3,
        reason: 'Long-standing partner page',
      })
    ).status,
    200,
  );
  for (const handle of [
    'keep_b',
    'keep_c',
    'keep_d',
    'keep_e',
    'keep_f',
    'keep_g',
  ])
    assert.equal((await rename(cookie, handle)).status, 200, handle);
  assert.deepEqual((await mine(cookie)).handleChanges, { used: 6, allowed: 6 });

  const other = await signIn(stack.api, '+2348031270009');
  for (const handle of [
    'keep_a',
    'keep_b',
    'keep_c',
    'keep_d',
    'keep_e',
    'keep_f',
  ]) {
    const old = await call('GET', `/v1/profiles/${handle}`);
    assert.equal(old.status, 308, handle);
    assert.equal(old.headers.get('location'), '/v1/profiles/keep_g');
    const grab = await call('POST', '/v1/me/page', other.cookie, { handle });
    assert.equal(grab.status, 409, handle);
    assert.equal(await code(grab), 'HANDLE_TAKEN');
  }
});

test('two changes at once on the last allowance: one wins', async () => {
  const cookie = await proPage('+2348031270010', 'race_0');
  assert.equal((await rename(cookie, 'race_1')).status, 200);
  assert.equal((await rename(cookie, 'race_2')).status, 200);
  const [left, right] = await Promise.all([
    rename(cookie, 'race_left'),
    rename(cookie, 'race_right'),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409]);
  const loser = left.status === 409 ? left : right;
  assert.equal(await code(loser), 'HANDLE_CHANGE_LIMIT');
  const profile = await mine(cookie);
  assert.equal(
    profile.handle,
    left.status === 200 ? 'race_left' : 'race_right',
  );
  assert.deepEqual(profile.handleChanges, { used: 3, allowed: 3 });
  assert.deepEqual([...profile.previousHandles].sort(), [
    'race_0',
    'race_1',
    'race_2',
  ]);
});

test('leaving Pro keeps the handle and refuses more changes; returning does not reset the count', async () => {
  const cookie = await proPage('+2348031270011', 'leave_a');
  assert.equal((await rename(cookie, 'leave_b')).status, 200);
  await setPlan('leave_b', 'free');
  const refused = await rename(cookie, 'leave_c');
  assert.equal(refused.status, 403);
  assert.equal(await code(refused), 'HANDLE_CHANGE_PRO_REQUIRED');
  let profile = await mine(cookie);
  assert.equal(profile.handle, 'leave_b');
  assert.equal((await call('GET', '/v1/profiles/leave_b')).status, 200);
  assert.equal((await call('GET', '/v1/profiles/leave_a')).status, 308);

  await setPlan('leave_b', 'pro');
  profile = await mine(cookie);
  assert.deepEqual(profile.handleChanges, { used: 1, allowed: 3 });
  assert.equal((await rename(cookie, 'leave_c')).status, 200);
  assert.equal((await rename(cookie, 'leave_d')).status, 200);
  assert.equal((await rename(cookie, 'leave_e')).status, 409);
});

test('staff can allow more, with a reason, and it is audited', async () => {
  const cookie = await proPage('+2348031270012', 'more_0');
  for (const handle of ['more_1', 'more_2', 'more_3'])
    assert.equal((await rename(cookie, handle)).status, 200);
  assert.equal((await rename(cookie, 'more_4')).status, 409);

  const reason = 'Changed their business name, verified by support';
  // A written reason and a sensible number are required, and nothing is granted without them.
  for (const body of [
    { extra: 1 },
    { extra: 1, reason: 'short' },
    { extra: 0, reason },
    { extra: -1, reason },
    { extra: 11, reason },
    { extra: 1.5, reason },
    { extra: '1', reason },
    { reason },
  ])
    assert.equal(
      (await grant('more_3', body)).status,
      400,
      JSON.stringify(body),
    );
  assert.equal((await grant('nobody_here', { extra: 1, reason })).status, 404);

  // Old handles find the page too, as the Pages lookup does.
  const granted = await grant('more_0', { extra: 2, reason });
  assert.equal(granted.status, 200);
  assert.deepEqual(await json(granted), { allowed: 5 });
  assert.deepEqual((await mine(cookie)).handleChanges, { used: 3, allowed: 5 });
  assert.equal((await rename(cookie, 'more_4')).status, 200);

  const page = await json(
    await call('GET', '/v1/ops/pages/more_4', staff.cookie),
  );
  assert.deepEqual(page.handleChanges, { used: 4, allowed: 5 });
  const { rows } = await database.pool.query(
    `SELECT action, permission, subject_type, reason FROM audit_events
      WHERE subject_id = $1 AND action LIKE 'page.handle%'`,
    [page.profileId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'page.handle_changes_granted');
  assert.equal(rows[0].permission, 'pages.plan');
  assert.equal(rows[0].subject_type, 'profile');
  assert.ok(rows[0].reason.startsWith(reason), rows[0].reason);
  assert.match(rows[0].reason, /\+2/, 'the audit says how many');

  // Grants add up.
  assert.deepEqual(await json(await grant('more_4', { extra: 1, reason })), {
    allowed: 6,
  });

  // An allowance doesn't make a Free page able to change its handle.
  const freeCookie = await livePage('+2348031270013', 'more_free');
  assert.equal((await grant('more_free', { extra: 1, reason })).status, 200);
  assert.equal(
    await code(await rename(freeCookie, 'more_free_2')),
    'HANDLE_CHANGE_PRO_REQUIRED',
  );

  // Without the permission it is refused; an ordinary session doesn't even see the admin.
  const limited = await opsSignIn(stack.api, database.db, '+2348031270098');
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('viewer', 'Viewer') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'viewer' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+2348031270098')`,
  );
  const response = await call(
    'POST',
    '/v1/ops/pages/more_4/handle-changes',
    limited.cookie,
    { extra: 1, reason },
  );
  assert.equal(response.status, 403);
  const recipient = await call(
    'POST',
    '/v1/ops/pages/more_4/handle-changes',
    cookie,
    { extra: 5, reason },
  );
  assert.equal(recipient.status, 404, 'the admin stays hidden');
  assert.deepEqual((await mine(cookie)).handleChanges, { used: 4, allowed: 6 });
});

test('staff can allow at most 20 extra changes on a page in total', async () => {
  const cookie = await proPage('+2348031270020', 'cap_page');
  const reason = 'Long-standing partner page';
  assert.deepEqual(await json(await grant('cap_page', { extra: 10, reason })), {
    allowed: 13,
  });
  assert.deepEqual(await json(await grant('cap_page', { extra: 10, reason })), {
    allowed: 23,
  });
  // The 21st extra change, in the smallest grant there is: refused, nothing changes or is recorded.
  const refused = await grant('cap_page', { extra: 1, reason });
  assert.equal(refused.status, 400);
  assert.equal(await code(refused), 'VALIDATION_FAILED');
  assert.deepEqual((await mine(cookie)).handleChanges, {
    used: 0,
    allowed: 23,
  });
  const { rows } = await database.pool.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE action = 'page.handle_changes_granted'
        AND subject_id = (SELECT id::text FROM profiles WHERE handle_lower = 'cap_page')`,
  );
  assert.equal(rows[0].n, 2);
  // The database holds the same line, whatever a later release does.
  await assert.rejects(
    database.pool.query(
      `UPDATE profiles SET handle_changes_extra = 21 WHERE handle_lower = 'cap_page'`,
    ),
    (error) =>
      error.code === '23514' && error.constraint === 'profiles_handle_changes',
  );
});

test('a change that loses a race for the handle uses up nothing', async () => {
  const cookie = await proPage('+2348031270021', 'lost_race');
  const other = await signIn(stack.api, '+2348031270022');
  const { rows: users } = await database.pool.query(
    `SELECT id FROM users WHERE phone_e164 = '+2348031270022'`,
  );
  // Someone else is mid-way through claiming the handle: their transaction holds its lock and
  // their row isn't visible yet, so the rename passes its check and then waits on the lock.
  const claimer = await database.pool.connect();
  let attempt;
  try {
    await claimer.query('BEGIN');
    await claimer.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.handle:lost_race_x'))`,
    );
    attempt = rename(cookie, 'lost_race_x');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await claimer.query(
      `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state)
       VALUES (gen_random_uuid(), $1, 'lost_race_x', 'lost_race_x', 'lost_race_x', 'not_live')`,
      [users[0].id],
    );
    await claimer.query('COMMIT');
  } finally {
    claimer.release();
  }
  const refused = await attempt;
  assert.equal(refused.status, 409);
  assert.equal(await code(refused), 'HANDLE_TAKEN');
  const profile = await mine(cookie);
  assert.equal(profile.handle, 'lost_race');
  assert.deepEqual(profile.handleChanges, { used: 0, allowed: 3 });
  assert.deepEqual(profile.previousHandles, []);
  assert.equal((await mine(other.cookie)).handle, 'lost_race_x');
});

test('deleting a page holds all its old handles, however many, and a first claim still works after', async () => {
  const handles = Array.from({ length: 8 }, (_, i) => `gone_${i}`);
  const cookie = await proPage('+2348031270023', handles[0]);
  assert.equal(
    (
      await grant(handles[0], {
        extra: 4,
        reason: 'Long-standing partner page',
      })
    ).status,
    200,
  );
  for (const handle of handles.slice(1))
    assert.equal((await rename(cookie, handle)).status, 200, handle);
  assert.equal((await mine(cookie)).previousHandles.length, 7);
  assert.equal(
    (await call('DELETE', '/v1/me/account', cookie, { confirm: 'DELETE' }))
      .status,
    204,
  );

  const { rows: aliases } = await database.pool.query(
    `SELECT count(*)::int AS n FROM handle_aliases WHERE handle_lower LIKE 'gone_%'`,
  );
  assert.equal(aliases[0].n, 0, 'they stop leading to the deleted page');
  const { rows: holds } = await database.pool.query(
    `SELECT handle_lower FROM handle_holds
      WHERE handle_lower LIKE 'gone_%' AND until > now() + interval '89 days'
      ORDER BY handle_lower`,
  );
  assert.deepEqual(
    holds.map((row) => row.handle_lower),
    handles,
  );

  // Held: nobody can take them. A first claim of another handle is untouched.
  const nearby = await signIn(stack.api, '+2348031270024');
  for (const handle of handles) {
    const grab = await call('POST', '/v1/me/page', nearby.cookie, { handle });
    assert.equal(grab.status, 409, handle);
    assert.equal(await code(grab), 'HANDLE_TAKEN');
  }
  assert.equal(
    (await call('POST', '/v1/me/page', nearby.cookie, { handle: 'gone_new' }))
      .status,
    201,
  );

  // Once a hold ends the handle is an ordinary first claim: a Free page, with its own count.
  await database.pool.query(
    `UPDATE handle_holds SET until = now() - interval '1 day' WHERE handle_lower = 'gone_0'`,
  );
  const later = await signIn(stack.api, '+2348031270025');
  assert.equal(
    (await call('POST', '/v1/me/page', later.cookie, { handle: 'gone_0' }))
      .status,
    201,
  );
  const profile = await mine(later.cookie);
  assert.equal(profile.plan, 'free');
  assert.deepEqual(profile.handleChanges, { used: 0, allowed: 3 });
  assert.equal(
    await code(await rename(later.cookie, 'gone_0_next')),
    'HANDLE_CHANGE_PRO_REQUIRED',
  );
});
