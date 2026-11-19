import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  assignUsername,
  mailSealing,
  openSecret,
  cancelHandoverLink,
  checkUsername,
  claimViaHandoverLink,
  createHandoverLink,
  endLinksOfStaffWithoutAccess,
  findHandoverAccounts,
  previewHandoverLink,
  releaseUsername,
  reserveUsername,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Username handover (owner's approval, 18 Nov 2026; reservation spec, "Handover"). A reserved name
// moves to one account, by a one-time claim link staff send themselves or by staff giving it to an
// account. The name stays reserved until the handover commits: the reservation ends and the handle
// is set in one transaction, under the same per-handle lock as the reservation code.

const REASON = 'The brand proved it owns this name';
const DAY = 86_400_000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
let n = 0;
const phone = () =>
  `+23481${String(Date.now() % 1e6).padStart(6, '0')}${String(n++ % 100).padStart(2, '0')}`;

async function user(database, { email = null } = {}) {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO users (id, phone_e164, email, email_verified_at) VALUES ($1, $2, $3, $4)`,
    [id, phone(), email, email ? new Date() : null],
  );
  return id;
}

async function withPage(database, handle, extra = {}) {
  const userId = await user(database, extra);
  const profileId = randomUUID();
  await database.pool.query(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, plan)
     VALUES ($1, $2, $3, $3, 'Kemi', 'live', $4)`,
    [profileId, userId, handle, extra.plan ?? 'free'],
  );
  return { userId, profileId };
}

/** Active staff in a role of the given permissions (a link's maker must hold usernames.manage). */
async function asStaff(database, userId, permissions = ['usernames.manage']) {
  const role = `handover_${permissions.join('_').replace(/\W/g, '_') || 'none'}`;
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`,
    [role],
  );
  for (const permission of permissions)
    await database.pool.query(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [role, permission],
    );
  await database.pool.query(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET role_id = $2, revoked_at = NULL`,
    [userId, role],
  );
  return userId;
}

async function setup(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const staffId = await asStaff(
    database,
    await user(database, { email: 'ops.lead@example.com' }),
  );
  return { database, staffId };
}

const reservationOf = async (database, name) =>
  (
    await database.pool.query(
      `SELECT * FROM handle_reservations WHERE handle_lower = $1 ORDER BY reserved_at DESC LIMIT 1`,
      [name],
    )
  ).rows[0];

const codeOf = (created) => created.path.split('#claim=')[1];

test('a claim link is a one-time code for one reserved name, stored only as its hash', async (t) => {
  const { database, staffId } = await setup(t);
  const now = new Date('2026-11-18T10:00:00Z');
  await reserveUsername(database.db, {
    staffId,
    name: 'Brand_A',
    reason: REASON,
    now,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'BRAND-A',
    reason: REASON,
    now,
  });
  const code = codeOf(created);
  assert.match(code, /^[A-Z2-7]{24}$/);
  assert.match(created.path, /^\/sign-up\/claim#claim=[A-Z2-7]{24}$/);
  assert.equal(created.link.name, 'brand_a');
  assert.equal(
    created.link.expiresAt,
    new Date(now.getTime() + 14 * DAY).toISOString(),
  );
  assert.ok(
    created.link.createdBy && !created.link.createdBy.includes('ops.lead'),
    'masked',
  );

  const { rows } = await database.pool.query(
    `SELECT * FROM handle_handover_links`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_sha256, sha256(code));
  // The code itself is nowhere in the database: not in the link row, not in the audit log.
  const everything = await database.pool.query(
    `SELECT row_to_json(l)::text AS t FROM handle_handover_links l
     UNION ALL SELECT row_to_json(a)::text FROM audit_events a`,
  );
  for (const row of everything.rows)
    assert.ok(!row.t.includes(code), 'code stored');

  const audit = await database.pool.query(
    `SELECT action, permission, subject_type, subject_id, reason FROM audit_events
      WHERE action LIKE 'username.handover%'`,
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].action, 'username.handover_link_created');
  assert.equal(audit.rows[0].permission, 'usernames.manage');
  assert.equal(audit.rows[0].subject_type, 'username');
  assert.equal(audit.rows[0].subject_id, 'brand_a');
  assert.ok(audit.rows[0].reason.startsWith(REASON));
  assert.ok(
    audit.rows[0].reason.includes(
      (await reservationOf(database, 'brand_a')).id,
    ),
  );

  assert.deepEqual(await previewHandoverLink(database.db, code, now), {
    state: 'open',
    name: 'brand_a',
    expiresAt: created.link.expiresAt,
  });
  // The staff check shows the open link (never the code).
  const check = await checkUsername(database.db, 'brand_a', now);
  assert.equal(check.state, 'reserved');
  assert.equal(check.handoverLink.id, created.link.id);
  assert.ok(!JSON.stringify(check).includes(code));
});

test('a claim link is refused for a built-in, an unreserved or a held name', async (t) => {
  const { database, staffId } = await setup(t);
  await rejects(
    createHandoverLink(database.db, { staffId, name: 'admin', reason: REASON }),
    'USERNAME_BUILT_IN',
  );
  await rejects(
    createHandoverLink(database.db, {
      staffId,
      name: 'nobody_has',
      reason: REASON,
    }),
    'USERNAME_NOT_RESERVED',
  );
  await rejects(
    createHandoverLink(database.db, {
      staffId,
      name: 'nobody_has',
      reason: 'short',
    }),
    'INVALID_INPUT',
  );
  // A deleted page's 90-day hold: the name protects that page's old links until it ends.
  await database.pool.query(
    `INSERT INTO handle_holds (handle_lower, until) VALUES ('held_name', now() + interval '10 days')`,
  );
  await reserveUsername(database.db, {
    staffId,
    name: 'held_name',
    reason: REASON,
  });
  await rejects(
    createHandoverLink(database.db, {
      staffId,
      name: 'held_name',
      reason: REASON,
    }),
    'USERNAME_IN_HOLD',
  );
  assert.equal(await database.count('handle_handover_links'), 0);
});

test('one live link per reservation: a new one cancels the old, and staff can cancel', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_b',
    reason: REASON,
  });
  const first = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_b',
    reason: REASON,
  });
  const second = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_b',
    reason: 'The first link went to the wrong person',
  });
  assert.deepEqual(await previewHandoverLink(database.db, codeOf(first)), {
    state: 'cancelled',
  });
  assert.equal(
    (await previewHandoverLink(database.db, codeOf(second))).state,
    'open',
  );

  const cancelled = await cancelHandoverLink(database.db, {
    staffId,
    name: 'brand_b',
    reason: 'The brand asked us to stop the link',
  });
  assert.equal(cancelled.id, second.link.id);
  assert.deepEqual(await previewHandoverLink(database.db, codeOf(second)), {
    state: 'cancelled',
  });
  await rejects(
    cancelHandoverLink(database.db, {
      staffId,
      name: 'brand_b',
      reason: REASON,
    }),
    'HANDOVER_LINK_NOT_FOUND',
  );
  const { rows } = await database.pool.query(
    `SELECT action FROM audit_events WHERE subject_id = 'brand_b' ORDER BY seq`,
  );
  assert.deepEqual(
    rows.map((r) => r.action),
    [
      'username.reserved',
      'username.handover_link_created',
      'username.handover_link_created',
      'username.handover_link_cancelled',
    ],
  );
  // The name is still reserved: cancelling a link changes nothing else.
  assert.equal((await checkUsername(database.db, 'brand_b')).state, 'reserved');
});

test('an unknown, expired or released link says so plainly', async (t) => {
  const { database, staffId } = await setup(t);
  assert.deepEqual(await previewHandoverLink(database.db, 'A'.repeat(24)), {
    state: 'invalid',
  });
  assert.deepEqual(await previewHandoverLink(database.db, 'not a code'), {
    state: 'invalid',
  });
  const now = new Date('2026-11-18T10:00:00Z');
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_c',
    reason: REASON,
    now,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_c',
    reason: REASON,
    now,
  });
  const later = new Date(now.getTime() + 14 * DAY);
  assert.deepEqual(
    await previewHandoverLink(database.db, codeOf(created), later),
    {
      state: 'expired',
    },
  );
  const userId = await user(database);
  await rejects(
    claimViaHandoverLink(database.db, {
      userId,
      code: codeOf(created),
      now: later,
    }),
    'CLAIM_LINK_INVALID',
  );
  // Releasing the reservation ends its link.
  await releaseUsername(database.db, {
    staffId,
    name: 'brand_c',
    reason: 'No longer needed here',
  });
  assert.deepEqual(
    await previewHandoverLink(database.db, codeOf(created), now),
    {
      state: 'cancelled',
    },
  );
  await rejects(
    claimViaHandoverLink(database.db, { userId, code: codeOf(created), now }),
    'CLAIM_LINK_INVALID',
  );
  assert.equal(
    await database.count("profiles WHERE handle_lower = 'brand_c'"),
    0,
  );
});

test('an account with no page claims the name: a new page, the reservation ended, the link used', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_d',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_d',
    reason: REASON,
  });
  const userId = await user(database);
  const claimed = await claimViaHandoverLink(database.db, {
    userId,
    code: codeOf(created),
  });
  assert.equal(claimed.handle, 'brand_d');
  assert.equal(claimed.previous, null);
  assert.equal(claimed.created, true);
  const { rows: page } = await database.pool.query(
    `SELECT id, handle_lower, page_state, handle_changes_used FROM profiles WHERE user_id = $1`,
    [userId],
  );
  assert.equal(page[0].handle_lower, 'brand_d');
  assert.equal(page[0].page_state, 'not_live');
  assert.equal(page[0].id, claimed.profileId);
  const reservation = await reservationOf(database, 'brand_d');
  assert.ok(reservation.released_at);
  assert.equal(reservation.handed_over_to, claimed.profileId);
  const { rows: link } = await database.pool.query(
    `SELECT used_at, used_by FROM handle_handover_links WHERE id = $1`,
    [created.link.id],
  );
  assert.ok(link[0].used_at);
  assert.equal(link[0].used_by, userId);
  // One time only.
  assert.deepEqual(await previewHandoverLink(database.db, codeOf(created)), {
    state: 'used',
  });
  await rejects(
    claimViaHandoverLink(database.db, {
      userId: await user(database),
      code: codeOf(created),
    }),
    'CLAIM_LINK_INVALID',
  );
  const { rows: audit } = await database.pool.query(
    `SELECT staff_user_id, permission, subject_type, subject_id, reason FROM audit_events
      WHERE action = 'username.claimed_via_link'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].staff_user_id, userId);
  assert.equal(audit[0].subject_id, 'brand_d');
  assert.ok(audit[0].reason.includes(reservation.id));
  assert.ok(!audit[0].reason.includes(codeOf(created)));
});

test('an account with a page claims the name: its old username keeps redirecting, no change is used', async (t) => {
  const { database, staffId } = await setup(t);
  const { userId, profileId } = await withPage(database, 'kemi_old');
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_e',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_e',
    reason: REASON,
  });
  const claimed = await claimViaHandoverLink(database.db, {
    userId,
    code: codeOf(created),
  });
  assert.deepEqual(
    {
      handle: claimed.handle,
      previous: claimed.previous,
      created: claimed.created,
      profileId: claimed.profileId,
    },
    { handle: 'brand_e', previous: 'kemi_old', created: false, profileId },
  );
  const { rows } = await database.pool.query(
    `SELECT p.handle_lower, p.handle_changes_used, a.handle_lower AS alias
       FROM profiles p LEFT JOIN handle_aliases a ON a.profile_id = p.id WHERE p.id = $1`,
    [profileId],
  );
  assert.deepEqual(rows, [
    { handle_lower: 'brand_e', handle_changes_used: 0, alias: 'kemi_old' },
  ]);
});

test('a claim is refused for a deleted page or one with a take-back under way, and changes nothing', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_f',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_f',
    reason: REASON,
  });
  const gone = await withPage(database, 'gone_page');
  await database.pool.query(
    `UPDATE profiles SET page_state = 'deleted' WHERE id = $1`,
    [gone.profileId],
  );
  await rejects(
    claimViaHandoverLink(database.db, {
      userId: gone.userId,
      code: codeOf(created),
    }),
    'HANDOVER_ACCOUNT_UNAVAILABLE',
  );
  const busy = await withPage(database, 'busy_page');
  await database.pool.query(
    `INSERT INTO handle_take_backs (id, profile_id, handle_lower, kind, category, notice_days, reason, state, requested_by, approved_at)
     VALUES ($1, $2, 'busy_page', 'current', 'ordinary', 7, 'A brand asked for it', 'approved', $3, now())`,
    [randomUUID(), busy.profileId, staffId],
  );
  await rejects(
    claimViaHandoverLink(database.db, {
      userId: busy.userId,
      code: codeOf(created),
    }),
    'HANDOVER_ACCOUNT_UNAVAILABLE',
  );
  assert.equal(
    (await previewHandoverLink(database.db, codeOf(created))).state,
    'open',
  );
  assert.equal((await checkUsername(database.db, 'brand_f')).state, 'reserved');
});

test('staff find an account by its current username or exact email, with no email shown', async (t) => {
  const { database } = await setup(t);
  const kemi = await withPage(database, 'kemi_find', {
    email: 'kemi.find@example.com',
  });
  const noPage = await user(database, { email: 'no.page@example.com' });
  const byHandle = await findHandoverAccounts(database.db, '@Kemi_Find');
  assert.equal(byHandle.length, 1);
  assert.equal(byHandle[0].userId, kemi.userId);
  assert.equal(byHandle[0].page.handle, 'kemi_find');
  const byEmail = await findHandoverAccounts(
    database.db,
    'KEMI.FIND@example.com',
  );
  assert.equal(byEmail[0].userId, kemi.userId);
  assert.equal(byEmail[0].foundBy, 'email');
  const bare = await findHandoverAccounts(database.db, 'no.page@example.com');
  assert.deepEqual(bare, [
    { userId: noPage, foundBy: 'email', page: null, staff: false },
  ]);
  // Exact email only, never a part of one; no email, phone or balance in any answer.
  assert.deepEqual(await findHandoverAccounts(database.db, 'kemi.find@'), []);
  assert.deepEqual(await findHandoverAccounts(database.db, 'example.com'), []);
  const text = JSON.stringify([byHandle, byEmail, bare]);
  for (const secret of ['example.com', 'kemi.find', 'no.page', '+234'])
    assert.ok(!text.includes(secret), secret);
});

test('staff give a reserved name to an account: old username redirects, open link cancelled, audited', async (t) => {
  const { database, staffId } = await setup(t);
  const kemi = await withPage(database, 'kemi_gets', { plan: 'pro' });
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_g',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_g',
    reason: REASON,
  });
  const assigned = await assignUsername(database.db, {
    staffId,
    name: 'Brand-G',
    userId: kemi.userId,
    reason: 'Their brand team asked by email on 18 Nov',
  });
  assert.deepEqual(assigned, {
    name: 'brand_g',
    handle: 'brand_g',
    previous: 'kemi_gets',
    profileId: kemi.profileId,
    created: false,
  });
  const { rows } = await database.pool.query(
    `SELECT p.handle_lower, p.handle_changes_used, a.handle_lower AS alias
       FROM profiles p LEFT JOIN handle_aliases a ON a.profile_id = p.id WHERE p.id = $1`,
    [kemi.profileId],
  );
  assert.deepEqual(rows, [
    { handle_lower: 'brand_g', handle_changes_used: 0, alias: 'kemi_gets' },
  ]);
  assert.deepEqual(await previewHandoverLink(database.db, codeOf(created)), {
    state: 'cancelled',
  });
  const reservation = await reservationOf(database, 'brand_g');
  assert.equal(reservation.released_by, staffId);
  assert.equal(reservation.handed_over_to, kemi.profileId);
  const { rows: audit } = await database.pool.query(
    `SELECT staff_user_id, permission, reason FROM audit_events WHERE action = 'username.assigned'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].staff_user_id, staffId);
  assert.equal(audit[0].permission, 'usernames.manage');
  assert.ok(
    audit[0].reason.startsWith('Their brand team asked by email on 18 Nov'),
  );
  assert.ok(audit[0].reason.includes(kemi.profileId));
});

test('staff can give a name to an account with no page yet, which then has one', async (t) => {
  const { database, staffId } = await setup(t);
  const userId = await user(database, { email: 'brand.h@example.com' });
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_h',
    reason: REASON,
  });
  const assigned = await assignUsername(database.db, {
    staffId,
    name: 'brand_h',
    userId,
    reason: REASON,
  });
  assert.equal(assigned.created, true);
  assert.equal(assigned.previous, null);
  const { rows } = await database.pool.query(
    `SELECT handle_lower FROM profiles WHERE user_id = $1`,
    [userId],
  );
  assert.deepEqual(rows, [{ handle_lower: 'brand_h' }]);
});

test('assignment is refused for a built-in or unreserved name, a missing account, and never takes a name from anyone', async (t) => {
  const { database, staffId } = await setup(t);
  const kemi = await withPage(database, 'kemi_keeps');
  await rejects(
    assignUsername(database.db, {
      staffId,
      name: 'admin',
      userId: kemi.userId,
      reason: REASON,
    }),
    'USERNAME_BUILT_IN',
  );
  // A page's own username is never reserved, so it can't be handed out.
  const other = await withPage(database, 'other_page');
  await rejects(
    assignUsername(database.db, {
      staffId,
      name: 'other_page',
      userId: kemi.userId,
      reason: REASON,
    }),
    'USERNAME_NOT_RESERVED',
  );
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_i',
    reason: REASON,
  });
  await rejects(
    assignUsername(database.db, {
      staffId,
      name: 'brand_i',
      userId: randomUUID(),
      reason: REASON,
    }),
    'HANDOVER_ACCOUNT_UNAVAILABLE',
  );
  const { rows } = await database.pool.query(
    `SELECT handle_lower FROM profiles WHERE id IN ($1, $2) ORDER BY handle_lower`,
    [kemi.profileId, other.profileId],
  );
  assert.deepEqual(
    rows.map((r) => r.handle_lower),
    ['kemi_keeps', 'other_page'],
  );
  assert.equal((await checkUsername(database.db, 'brand_i')).state, 'reserved');
});

// Races. One connection holds the name's lock (the same one the reservation code takes) while both
// sides queue behind it; then it lets go and they run one after the other. Exactly one wins, and
// the name is never both free and unowned, or owned twice.

async function holdingName(database, name, run, waiters = 2) {
  const holder = new pg.Client({ connectionString: database.url });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [
      `tipme.handle:${name}`,
    ]);
    // Settled at once: a side refused before it queues must not be an unhandled rejection.
    const pending = run().map((promise) =>
      promise.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      ),
    );
    let queued = 0;
    for (let i = 0; i < 200; i++) {
      const { rows } = await database.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND datname = current_database()`,
      );
      queued = rows[0].n;
      if (queued >= waiters) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      queued >= waiters,
      `${queued} of ${waiters} queued behind the lock`,
    );
    await holder.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    await holder.end();
  }
}

const owners = async (database, name) =>
  (
    await database.pool.query(
      `SELECT (SELECT count(*)::int FROM profiles WHERE handle_lower = $1) AS pages,
              (SELECT count(*)::int FROM handle_reservations WHERE handle_lower = $1 AND released_at IS NULL) AS reserved`,
      [name],
    )
  ).rows[0];

test('race: two claims of one link at once, exactly one gets the name', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'race_two',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'race_two',
    reason: REASON,
  });
  const [a, b] = [await user(database), await user(database)];
  const results = await holdingName(database, 'race_two', () => [
    claimViaHandoverLink(database.db, { userId: a, code: codeOf(created) }),
    claimViaHandoverLink(database.db, { userId: b, code: codeOf(created) }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    'fulfilled',
    'rejected',
  ]);
  assert.equal(
    results.find((r) => r.status === 'rejected').reason.code,
    'CLAIM_LINK_INVALID',
  );
  assert.deepEqual(await owners(database, 'race_two'), {
    pages: 1,
    reserved: 0,
  });
});

test('race: a claim against a release, exactly one of them happens', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'race_rel',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'race_rel',
    reason: REASON,
  });
  const userId = await user(database);
  const [claimed, released] = await holdingName(database, 'race_rel', () => [
    claimViaHandoverLink(database.db, { userId, code: codeOf(created) }),
    releaseUsername(database.db, {
      staffId,
      name: 'race_rel',
      reason: 'Released by a colleague',
    }),
  ]);
  assert.equal(
    [claimed, released].filter((r) => r.status === 'fulfilled').length,
    1,
  );
  if (claimed.status === 'fulfilled') {
    assert.equal(released.reason.code, 'USERNAME_NOT_RESERVED');
    assert.deepEqual(await owners(database, 'race_rel'), {
      pages: 1,
      reserved: 0,
    });
  } else {
    assert.equal(claimed.reason.code, 'CLAIM_LINK_INVALID');
    assert.deepEqual(await owners(database, 'race_rel'), {
      pages: 0,
      reserved: 0,
    });
  }
});

test('race: a claim against an assignment, exactly one account gets the name', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'race_give',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'race_give',
    reason: REASON,
  });
  const claimer = await user(database);
  const kemi = await withPage(database, 'kemi_race');
  const [claimed, assigned] = await holdingName(database, 'race_give', () => [
    claimViaHandoverLink(database.db, {
      userId: claimer,
      code: codeOf(created),
    }),
    assignUsername(database.db, {
      staffId,
      name: 'race_give',
      userId: kemi.userId,
      reason: REASON,
    }),
  ]);
  assert.equal(
    [claimed, assigned].filter((r) => r.status === 'fulfilled').length,
    1,
  );
  const loser = claimed.status === 'rejected' ? claimed : assigned;
  assert.equal(
    loser.reason.code,
    claimed.status === 'rejected'
      ? 'CLAIM_LINK_INVALID'
      : 'USERNAME_NOT_RESERVED',
  );
  assert.deepEqual(await owners(database, 'race_give'), {
    pages: 1,
    reserved: 0,
  });
});

test('race: a sign-up claiming the name while it is handed over is refused until the handover commits', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'race_sign',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'race_sign',
    reason: REASON,
  });
  const claimer = await user(database);
  const stranger = await user(database);
  const { claimHandle } = await import('../../dist/index.js');
  const [handed, signUp] = await holdingName(
    database,
    'race_sign',
    () => [
      claimViaHandoverLink(database.db, {
        userId: claimer,
        code: codeOf(created),
      }),
      claimHandle(database.db, { userId: stranger, handle: 'race_sign' }),
    ],
    1,
  );
  assert.equal(handed.status, 'fulfilled');
  assert.equal(signUp.status, 'rejected');
  assert.equal(signUp.reason.code, 'HANDLE_TAKEN');
  const { rows } = await database.pool.query(
    `SELECT user_id FROM profiles WHERE handle_lower = 'race_sign'`,
  );
  assert.deepEqual(rows, [{ user_id: claimer }]);
});

// Security review fixes (PR #280).

const sealing = mailSealing(Buffer.alloc(32, 7));

test('review: no active staff account receives a handed-over name, by assignment or by link', async (t) => {
  const { database, staffId } = await setup(t);
  await withPage(database, 'staff_own_page');
  const [{ user_id: ownStaff }] = (
    await database.pool.query(
      `SELECT user_id FROM profiles WHERE handle_lower = 'staff_own_page'`,
    )
  ).rows;
  await asStaff(database, ownStaff);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_staff',
    reason: REASON,
  });
  // To themselves, and to a colleague.
  await rejects(
    assignUsername(database.db, {
      staffId,
      name: 'brand_staff',
      userId: staffId,
      reason: REASON,
    }),
    'HANDOVER_STAFF_ACCOUNT',
  );
  await rejects(
    assignUsername(database.db, {
      staffId,
      name: 'brand_staff',
      userId: ownStaff,
      reason: REASON,
    }),
    'HANDOVER_STAFF_ACCOUNT',
  );
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_staff',
    reason: REASON,
  });
  await rejects(
    claimViaHandoverLink(database.db, {
      userId: staffId,
      code: codeOf(created),
    }),
    'HANDOVER_STAFF_ACCOUNT',
  );
  await rejects(
    claimViaHandoverLink(database.db, {
      userId: ownStaff,
      code: codeOf(created),
    }),
    'HANDOVER_STAFF_ACCOUNT',
  );
  assert.equal(
    (await previewHandoverLink(database.db, codeOf(created))).state,
    'open',
  );
  assert.equal(
    (await checkUsername(database.db, 'brand_staff')).state,
    'reserved',
  );
  // Former staff are ordinary accounts again.
  await database.pool.query(
    `UPDATE staff SET revoked_at = now() WHERE user_id = $1`,
    [ownStaff],
  );
  assert.equal(
    (
      await assignUsername(database.db, {
        staffId,
        name: 'brand_staff',
        userId: ownStaff,
        reason: REASON,
      })
    ).handle,
    'brand_staff',
  );
  // The account search says who is staff, so the screen can say so before anyone tries.
  const [found] = await findHandoverAccounts(
    database.db,
    'ops.lead@example.com',
  );
  assert.equal(found.staff, true);
});

test('review: a link stops working once its maker is no longer staff holding usernames.manage', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_gone',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_gone',
    reason: REASON,
  });
  const claimer = await user(database);
  // The permission taken away (another role): refused, and nothing changes.
  await asStaff(database, staffId, ['search.view']);
  // N1: the preview agrees with the claim, and no longer names the username.
  assert.deepEqual(await previewHandoverLink(database.db, codeOf(created)), {
    state: 'cancelled',
  });
  await rejects(
    claimViaHandoverLink(database.db, {
      userId: claimer,
      code: codeOf(created),
    }),
    'CLAIM_LINK_INVALID',
  );
  // Removed from staff: refused too.
  await asStaff(database, staffId);
  await database.pool.query(
    `UPDATE staff SET revoked_at = now() WHERE user_id = $1`,
    [staffId],
  );
  await rejects(
    claimViaHandoverLink(database.db, {
      userId: claimer,
      code: codeOf(created),
    }),
    'CLAIM_LINK_INVALID',
  );
  assert.equal(
    (await checkUsername(database.db, 'brand_gone')).state,
    'reserved',
  );
  // Back with the permission, the same link works.
  await asStaff(database, staffId);
  assert.equal(
    (
      await claimViaHandoverLink(database.db, {
        userId: claimer,
        code: codeOf(created),
      })
    ).handle,
    'brand_gone',
  );
});

test('review: a suspended page or a blocked account takes no name, by link or assignment', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_susp',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_susp',
    reason: REASON,
  });
  const paused = await withPage(database, 'paused_page');
  await database.pool.query(
    `UPDATE profiles SET status = 'suspended' WHERE id = $1`,
    [paused.profileId],
  );
  const blocked = await withPage(database, 'blocked_acct');
  await database.pool.query(
    `UPDATE users SET status = 'suspended' WHERE id = $1`,
    [blocked.userId],
  );
  const bare = await user(database);
  await database.pool.query(
    `UPDATE users SET status = 'suspended' WHERE id = $1`,
    [bare],
  );
  for (const userId of [paused.userId, blocked.userId, bare]) {
    await rejects(
      assignUsername(database.db, {
        staffId,
        name: 'brand_susp',
        userId,
        reason: REASON,
      }),
      'HANDOVER_ACCOUNT_UNAVAILABLE',
    );
    await rejects(
      claimViaHandoverLink(database.db, { userId, code: codeOf(created) }),
      'HANDOVER_ACCOUNT_UNAVAILABLE',
    );
  }
  assert.equal(
    (await checkUsername(database.db, 'brand_susp')).state,
    'reserved',
  );
});

test('review: a page whose take-back waits for a second person takes no name', async (t) => {
  const { database, staffId } = await setup(t);
  const kemi = await withPage(database, 'kemi_waiting');
  await database.pool.query(
    `INSERT INTO approval_requests (id, action, payload, summary, permission, requested_by, reason, status, created_at, expires_at)
     VALUES ($1, 'username.take_back', $2, 'Take kemi_waiting back', 'usernames.manage', $3, 'A brand asked for it', 'pending', now(), now() + interval '1 day')`,
    [
      randomUUID(),
      JSON.stringify({
        profileId: kemi.profileId,
        name: 'kemi_waiting',
        kind: 'current',
        category: 'ordinary',
        noticeDays: 7,
      }),
      staffId,
    ],
  );
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_wait',
    reason: REASON,
  });
  await rejects(
    assignUsername(database.db, {
      staffId,
      name: 'brand_wait',
      userId: kemi.userId,
      reason: REASON,
    }),
    'HANDOVER_ACCOUNT_UNAVAILABLE',
  );
});

test('review: a built-in word is never handed out, even through a link made before it joined the list', async (t) => {
  const { database, staffId } = await setup(t);
  // As if 'admin' had been reserved and linked before it became a built-in word.
  const reservationId = randomUUID();
  await database.pool.query(
    `INSERT INTO handle_reservations (id, handle_lower, source, reason, reserved_by, reserved_at) VALUES ($1, 'admin', 'staff', 'Old', $2, now())`,
    [reservationId, staffId],
  );
  const code = 'ADMINADMINADMINADMINADMI';
  await database.pool.query(
    `INSERT INTO handle_handover_links (id, reservation_id, handle_lower, token_sha256, created_by, created_at, expires_at)
     VALUES ($1, $2, 'admin', $3, $4, now(), now() + interval '1 day')`,
    [randomUUID(), reservationId, sha256(code), staffId],
  );
  await rejects(
    claimViaHandoverLink(database.db, { userId: await user(database), code }),
    'USERNAME_BUILT_IN',
  );
  assert.equal(
    await database.count(`profiles WHERE handle_lower = 'admin'`),
    0,
  );
});

test('review: giving a name emails the person fixed words, never the reason', async (t) => {
  const { database, staffId } = await setup(t);
  const kemi = await withPage(database, 'kemi_mailed', {
    email: 'kemi.mailed@example.com',
  });
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_mail',
    reason: REASON,
  });
  await assignUsername(database.db, {
    staffId,
    name: 'brand_mail',
    userId: kemi.userId,
    reason: 'Secret internal reason about the brand deal',
    sealing,
  });
  const { rows } = await database.pool.query(
    `SELECT user_id, data_sealed FROM mail_messages WHERE type = 'username_assigned'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, kemi.userId);
  const data = JSON.parse(openSecret(sealing.key, rows[0].data_sealed));
  assert.deepEqual(data, { new: 'brand_mail', old: 'kemi_mailed' });
  assert.ok(!JSON.stringify(data).includes('Secret'));
});

test('review: a sign-up for the same account during a no-page claim: one wins, never a deadlock', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'race_self',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'race_self',
    reason: REASON,
  });
  const claimer = await user(database);
  const { claimHandle } = await import('../../dist/index.js');
  const settle = (promise) =>
    promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    );
  const holder = new pg.Client({ connectionString: database.url });
  await holder.connect();
  let claim;
  let own;
  try {
    await holder.query('BEGIN');
    await holder.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.handle:race_self'))`,
    );
    // The claim takes the account, then queues behind the name.
    const handed = settle(
      claimViaHandoverLink(database.db, {
        userId: claimer,
        code: codeOf(created),
      }),
    );
    let queued = 0;
    for (let i = 0; i < 200 && queued < 1; i++) {
      queued = (
        await database.pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'advisory' AND datname = current_database()`,
        )
      ).rows[0].n;
      if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(queued, 1);
    // Meanwhile the same account signs up with a name of its own in another tab: it isn't held up.
    own = await settle(
      claimHandle(database.db, { userId: claimer, handle: 'own_choice_x' }),
    );
    await holder.query('COMMIT');
    claim = await handed;
  } finally {
    await holder.end();
  }
  assert.equal(own.status, 'fulfilled');
  assert.equal(claim.status, 'rejected');
  // A refusal to try again (the account changed), not a deadlock or a dead link.
  assert.equal(claim.reason.code, 'HANDOVER_ACCOUNT_CHANGED');
  const { rows } = await database.pool.query(
    `SELECT handle_lower FROM profiles WHERE user_id = $1`,
    [claimer],
  );
  assert.deepEqual(rows, [{ handle_lower: 'own_choice_x' }]);
  assert.equal(
    (await checkUsername(database.db, 'race_self')).state,
    'reserved',
  );
  // Trying again now renames their new page.
  assert.equal(
    (
      await claimViaHandoverLink(database.db, {
        userId: claimer,
        code: codeOf(created),
      })
    ).previous,
    'own_choice_x',
  );
});

test('review N1: only staff holding usernames.manage make links or give names, in the database too', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_actor',
    reason: REASON,
  });
  const outsider = await user(database);
  await rejects(
    createHandoverLink(database.db, {
      staffId: outsider,
      name: 'brand_actor',
      reason: REASON,
    }),
    'PERMISSION_NOT_HELD',
  );
  await rejects(
    assignUsername(database.db, {
      staffId: outsider,
      name: 'brand_actor',
      userId: await user(database),
      reason: REASON,
    }),
    'PERMISSION_NOT_HELD',
  );
  assert.equal(await database.count('handle_handover_links'), 0);
});

test('review N2: a claim committing during a staff-change cleanup keeps its link used, and the change succeeds', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_n2',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_n2',
    reason: REASON,
  });
  const claimer = await user(database);
  // The claim holds the link row: it has written "used" and not yet committed.
  const claim = new pg.Client({ connectionString: database.url });
  await claim.connect();
  await claim.query('BEGIN');
  await claim.query(
    `UPDATE handle_handover_links SET used_at = now(), used_by = $1 WHERE id = $2`,
    [claimer, created.link.id],
  );
  // The staff change: the maker loses usernames.manage, then the cleanup, in one transaction.
  let done = false;
  const change = database.db
    .transaction(async (tx) => {
      await tx.execute(
        `UPDATE staff SET revoked_at = now() WHERE user_id = '${staffId}'`,
      );
      return endLinksOfStaffWithoutAccess(tx, {
        actorId: staffId,
        trigger: 'staff.removed',
        now: new Date(),
      });
    })
    .then(
      (value) => ({ ok: value }),
      (error) => ({ error }),
    )
    .finally(() => {
      done = true;
    });
  // Either it skips the held row and finishes, or it waits on it: then the claim commits.
  for (let i = 0; i < 200 && !done; i++) {
    const { rows } = await database.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if (rows[0].n >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await claim.query('COMMIT');
  await claim.end();
  const result = await change;
  assert.ok(
    'ok' in result,
    String(result.error?.cause?.code ?? result.error?.code ?? result.error),
  );
  const { rows } = await database.pool.query(
    `SELECT used_at IS NOT NULL AS used, cancelled_at IS NOT NULL AS cancelled FROM handle_handover_links WHERE id = $1`,
    [created.link.id],
  );
  assert.deepEqual(rows, [{ used: true, cancelled: false }]);
  const audit = await database.pool.query(
    `SELECT 1 FROM audit_events WHERE action = 'username.handover_link_cancelled' AND reason LIKE $1`,
    [`%${created.link.id}%`],
  );
  assert.equal(audit.rowCount, 0);
});

test('review N2: an automatic cancellation is recorded as TipMe acting, naming the trigger', async (t) => {
  const { database, staffId } = await setup(t);
  await reserveUsername(database.db, {
    staffId,
    name: 'brand_n2b',
    reason: REASON,
  });
  const created = await createHandoverLink(database.db, {
    staffId,
    name: 'brand_n2b',
    reason: REASON,
  });
  const actor = await user(database);
  await database.pool.query(
    `UPDATE staff SET revoked_at = now() WHERE user_id = $1`,
    [staffId],
  );
  const ended = await database.db.transaction((tx) =>
    endLinksOfStaffWithoutAccess(tx, {
      actorId: actor,
      trigger: 'staff.access_changed',
      now: new Date(),
    }),
  );
  assert.equal(ended, 1);
  const { rows } = await database.pool.query(
    `SELECT staff_user_id, reason FROM audit_events WHERE action = 'username.handover_link_cancelled' AND reason LIKE $1`,
    [`%${created.link.id}%`],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].staff_user_id, null);
  assert.ok(
    rows[0].reason.startsWith(
      'Ended automatically: the person who made it no longer holds usernames.manage.',
    ),
  );
  assert.ok(rows[0].reason.includes(`"triggeredBy":"${actor}"`));
  assert.ok(rows[0].reason.includes('"trigger":"staff.access_changed"'));
  assert.deepEqual(await previewHandoverLink(database.db, codeOf(created)), {
    state: 'cancelled',
  });
});
