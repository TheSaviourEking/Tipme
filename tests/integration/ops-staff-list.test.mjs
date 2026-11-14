import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';

// The admin staff list (GET /v1/ops/staff) for a large team: the same answer the person-by-person
// reading gave, in a fixed handful of statements however many people there are.

let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
});
after(async () => {
  await database.close();
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

/** Counts statements sent through the pool while `work` runs. */
async function countingQueries(work) {
  const original = database.pool.query;
  let count = 0;
  database.pool.query = function (...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    return { result: await work(), count: () => count };
  } finally {
    database.pool.query = original;
  }
}

const HOUR = 3_600_000;
const NOW = Date.now();
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR);

async function role(id, name, permissions) {
  await q(`INSERT INTO roles (id, name) VALUES ($1, $2)`, [id, name]);
  for (const permission of permissions)
    await q(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
      [id, permission],
    );
}

let mailSeq = 0;
async function invitationMail(userId, status, createdAt, id) {
  mailSeq += 1;
  await q(
    `INSERT INTO mail_messages (id, type, category, user_id, dedupe_key, to_hint, status, priority,
       next_attempt_at, created_at)
     VALUES ($1, 'staff_invitation', 'security', $2, $3, 'a•••@example.com', $4, 0, $5, $5)`,
    [
      id ?? crypto.randomUUID(),
      userId,
      `staff-list.${mailSeq}`,
      status,
      createdAt,
    ],
  );
}

async function link(userId, { used = false, expired = false } = {}) {
  await q(
    `INSERT INTO staff_enrolments (code_sha256, user_id, expires_at, used_at) VALUES ($1, $2, $3, $4)`,
    [
      crypto.randomUUID(),
      userId,
      expired ? at(1) : at(-24),
      used ? at(2) : null,
    ],
  );
}

/**
 * About sixty people across every shape the list shows: owners, the fixed release-check role,
 * custom roles with personal additions and removals, people enrolled or not (with and without an
 * authenticator row), invitation emails in several states (two at the same moment, so the id
 * decides), open, used and expired links, phone-only accounts, and removed people left out.
 */
async function seedTeam() {
  await ops.ensureOwnerRole(database.db);
  await q(
    `INSERT INTO roles (id, name, system) VALUES ('release_check', 'Release check', true)
     ON CONFLICT (id) DO NOTHING`,
  );
  await q(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('release_check', 'issues.view')
     ON CONFLICT DO NOTHING`,
  );
  await role('support', 'Support', [
    'issues.view',
    'issues.resolve',
    'search.view',
  ]);
  await role('money', 'Money', [
    'fees.manage',
    'payouts.resolve',
    'payments.recheck',
  ]);
  await role('empty', 'Nobody yet', []);
  const roleIds = ['owner', 'release_check', 'support', 'money', 'empty'];
  const people = [];
  for (let i = 0; i < 62; i += 1) {
    const email = i % 7 === 3 ? null : `staff${i}@example.com`;
    const [{ id }] = await q(
      `INSERT INTO users (id, email, phone_e164, email_verified_at)
       VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
      [email, email ? null : `+2348077${String(i).padStart(5, '0')}`],
    );
    const roleId = roleIds[i % roleIds.length];
    // Granted in an order unlike insertion, so the list's oldest-first order is really tested.
    await q(
      `INSERT INTO staff (user_id, role_id, granted_at, revoked_at) VALUES ($1, $2, $3, $4)`,
      [id, roleId, at(1000 - ((i * 37) % 62)), i % 11 === 5 ? at(1) : null],
    );
    const shape = i % 3;
    if (shape !== 2)
      await q(
        `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, 'sealed', $2)`,
        [id, shape === 0 ? at(5) : null],
      );
    if (i % 4 === 1)
      await q(
        `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by)
         VALUES ($1, 'audit.view', 'add', $1), ($1, 'analytics.view', 'add', $1)`,
        [id],
      );
    if (i % 5 === 2)
      await q(
        `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by)
         VALUES ($1, 'issues.view', 'remove', $1), ($1, 'fees.manage', 'remove', $1)`,
        [id],
      );
    if (i % 6 === 1) {
      await invitationMail(id, 'failed', at(30));
      await invitationMail(id, 'sent', at(20));
    }
    if (i % 6 === 4) {
      // Two at the same moment: the larger id is the newest.
      await invitationMail(
        id,
        'bounced',
        at(10),
        `ffffffff-0000-7000-8000-${String(i).padStart(12, '0')}`,
      );
      await invitationMail(
        id,
        'queued',
        at(10),
        `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      );
    }
    if (i % 6 === 5) await invitationMail(id, 'suppressed', at(3));
    if (i % 4 === 0) await link(id);
    if (i % 4 === 2) await link(id, { used: true });
    if (i % 4 === 3) await link(id, { expired: true });
    if (i % 8 === 7) {
      await link(id, { expired: true });
      await link(id);
    }
    people.push({ id, roleId, email });
  }
  return people;
}

/** What the list said before it read in batches: each person's role, adjustments and invitation alone. */
async function personByPerson() {
  const rows = await q(
    `SELECT s.user_id, u.email, s.role_id, r.name, s.granted_at, t.confirmed_at
       FROM staff s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = s.role_id
       LEFT JOIN staff_totp t ON t.user_id = s.user_id
      WHERE s.revoked_at IS NULL ORDER BY s.granted_at`,
  );
  const people = [];
  for (const row of rows) {
    const access = await ops.readStaffAccess(database.db, row.user_id);
    const [mail] = await q(
      `SELECT status FROM mail_messages WHERE user_id = $1 AND type = 'staff_invitation'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [row.user_id],
    );
    const [open] = await q(
      `SELECT 1 FROM staff_enrolments WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() LIMIT 1`,
      [row.user_id],
    );
    people.push({
      userId: row.user_id,
      email: row.email,
      roleId: row.role_id,
      roleName: row.name,
      grantedAt: row.granted_at.toISOString(),
      enrolled: Boolean(row.confirmed_at),
      invitation: row.confirmed_at
        ? null
        : { status: mail?.status ?? 'none', linkOpen: Boolean(open) },
      permissions: [...access.permissions].sort(),
      additions: access.additions,
      removals: access.removals,
    });
  }
  return people;
}

test('the staff list for a large team: the same people, order and fields, in a few statements', async (t) => {
  const team = await seedTeam();
  const expected = await personByPerson();
  // Removed people are left out; everyone else is there.
  assert.equal(expected.length, team.filter((_, i) => i % 11 !== 5).length);
  assert.ok(expected.length >= 55);

  const started = performance.now();
  const { result, count } = await countingQueries(() =>
    ops.activeStaffList(database.db),
  );
  const elapsed = performance.now() - started;
  t.diagnostic(
    `activeStaffList: ${expected.length} people, ${count()} statements, ${elapsed.toFixed(1)} ms`,
  );
  assert.deepEqual(result, expected);

  // Some facts by hand, so this isn't only the reference agreeing with itself.
  const byId = new Map(result.map((row) => [row.userId, row]));
  const owner = byId.get(team[0].id);
  assert.equal(owner.roleId, 'owner');
  assert.equal(owner.enrolled, true);
  assert.equal(owner.invitation, null);
  assert.equal(owner.permissions.length, 24);
  const added = byId.get(team[13].id); // money, i % 4 === 1: two additions, not enrolled
  assert.deepEqual(added.additions, ['analytics.view', 'audit.view']);
  assert.ok(added.permissions.includes('audit.view'));
  assert.deepEqual(added.invitation, { status: 'sent', linkOpen: false });
  const removed = byId.get(team[22].id); // money, i % 5 === 2: removals bite
  assert.deepEqual(removed.removals, ['fees.manage', 'issues.view']);
  assert.ok(!removed.permissions.includes('fees.manage'));
  const tied = byId.get(team[4].id); // i % 6 === 4, same moment: the larger id wins
  assert.deepEqual(tied.invitation, { status: 'bounced', linkOpen: true });
  const phoneOnly = byId.get(team[10].id);
  assert.equal(phoneOnly.email, null);
  for (let i = 1; i < result.length; i += 1)
    assert.ok(result[i - 1].grantedAt <= result[i].grantedAt);

  // One read of the people, one each for roles, adjustments, invitation emails and links. One
  // person at a time it was two to four statements each: over 200 for this team.
  assert.ok(count() <= 8, `activeStaffList sent ${count()} queries`);
});
