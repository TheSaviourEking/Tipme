import assert from 'node:assert/strict';
import { after, before, test, beforeEach } from 'node:test';
import { OPS_PERMISSIONS } from '../../packages/contracts/dist/index.js';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  changeRole,
  createDatabase,
  createRole,
  deleteRole,
  effectiveAccess,
  grantOwner,
  listAudit,
  roleImpact,
  runMigrations,
  seedDemoProfiles,
  setPersonalAccess,
  staffPermissions,
  updateRole,
} from '../../packages/database/dist/index.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const REASON = 'Agreed with the owner in the weekly review';

let database;
let stack;
let owner;
let ownerId;
let phoneSuffix = 7000;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_OPS_REQUEST_PER_HOUR: '10000',
    },
  });
  owner = await staffSignIn('+2348036667000');
  ownerId = await userIdOf(owner);
});
after(async () => {
  await stack.stop();
  await database.close();
});

// Each test starts with the owner alone, so what it does runs at once. The serious paths, with a
// second person, are in ops-serious-gating.test.mjs.
beforeEach(async () => {
  await database.pool.query(
    `UPDATE staff SET revoked_at = now() WHERE revoked_at IS NULL AND user_id <> $1`,
    [ownerId],
  );
  await database.pool.query(
    `UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`,
  );
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const errorCode = async (response) => (await response.json()).error?.code;
const dataOf = async (response) => (await response.json()).data;

const phoneOf = new WeakMap();
async function staffSignIn(phone) {
  const person = await opsSignIn(stack.api, database.db, phone);
  phoneOf.set(person, phone);
  return person;
}
async function userIdOf(person) {
  const { rows } = await database.pool.query(
    'SELECT id FROM users WHERE phone_e164 = $1',
    [phoneOf.get(person)],
  );
  return rows[0].id;
}

let roleCounter = 0;
const uniqueName = (label) => `${label} ${++roleCounter}`;

/** A signed-in staff member on a new role holding exactly `permissions`. */
async function staffWith(permissions) {
  const person = await staffSignIn(`+234803666${++phoneSuffix}`);
  const userId = await userIdOf(person);
  const role = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Team'),
    description: '',
    permissions,
    reason: REASON,
  });
  await changeRole(database.db, {
    actorId: ownerId,
    userId,
    roleId: role.id,
    reason: REASON,
  });
  const result = { ...person, userId, roleId: role.id };
  phoneOf.set(result, phoneOf.get(person));
  return result;
}

const sorted = (set) => [...set].sort();

/** The person's reason and the server's record of the change, from one audit row. */
const MARKER = ' [change: ';
function auditParts(row) {
  const at = row.reason.indexOf(MARKER);
  assert.notEqual(at, -1, 'audit reason has no change record');
  assert.ok(row.reason.endsWith(']'));
  return {
    text: row.reason.slice(0, at),
    change: JSON.parse(row.reason.slice(at + MARKER.length, -1)),
  };
}
const newestAudit = async () => (await listAudit(database.db, { limit: 1 }))[0];
const ownersActive = async () =>
  (
    await database.pool.query(
      `SELECT count(*)::int AS n FROM staff WHERE role_id = 'owner' AND revoked_at IS NULL`,
    )
  ).rows[0].n;

test('a role grants what is ticked, and a new role starts with nothing', async () => {
  const created = await call('POST', '/v1/ops/staff/roles', owner.cookie, {
    name: uniqueName('Empty'),
    reason: REASON,
  });
  assert.equal(created.status, 201);
  const empty = await dataOf(created);
  assert.deepEqual(empty.permissions, []);
  assert.equal(empty.system, false);
  assert.match(empty.id, /^[0-9a-f-]{36}$/);

  const person = await staffWith([]);
  assert.equal((await call('GET', '/v1/ops/audit', person.cookie)).status, 403);
  const ticked = await call(
    'PATCH',
    `/v1/ops/staff/roles/${person.roleId}`,
    owner.cookie,
    { permissions: ['audit.view'], reason: REASON },
  );
  assert.equal(ticked.status, 200);
  assert.equal((await call('GET', '/v1/ops/audit', person.cookie)).status, 200);
  assert.deepEqual(sorted(await staffPermissions(database.db, person.userId)), [
    'audit.view',
  ]);
});

test('a duplicate role name is refused, whatever its case', async () => {
  const name = uniqueName('Refunds');
  assert.equal(
    (
      await call('POST', '/v1/ops/staff/roles', owner.cookie, {
        name,
        reason: REASON,
      })
    ).status,
    201,
  );
  const again = await call('POST', '/v1/ops/staff/roles', owner.cookie, {
    name: `  ${name.toUpperCase()} `,
    reason: REASON,
  });
  assert.equal(again.status, 409);
  assert.equal(await errorCode(again), 'ROLE_NAME_TAKEN');
  const ownerName = await call('POST', '/v1/ops/staff/roles', owner.cookie, {
    name: 'oWnEr',
    reason: REASON,
  });
  assert.equal(ownerName.status, 409);
  const other = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Other'),
    description: '',
    permissions: [],
    reason: REASON,
  });
  const rename = await call(
    'PATCH',
    `/v1/ops/staff/roles/${other.id}`,
    owner.cookie,
    { name: name.toLowerCase(), reason: REASON },
  );
  assert.equal(rename.status, 409);
});

test('owner and release_check cannot be edited or deleted', async () => {
  for (const id of ['owner', 'release_check']) {
    if (id === 'release_check')
      await database.pool.query(
        `INSERT INTO roles (id, name, system) VALUES ('release_check', 'Release check', true) ON CONFLICT DO NOTHING`,
      );
    const edit = await call(
      'PATCH',
      `/v1/ops/staff/roles/${id}`,
      owner.cookie,
      { name: uniqueName('Renamed'), reason: REASON },
    );
    assert.equal(edit.status, 409, id);
    assert.equal(await errorCode(edit), 'ROLE_PROTECTED');
    const remove = await call(
      'POST',
      `/v1/ops/staff/roles/${id}/delete`,
      owner.cookie,
      { reason: REASON },
    );
    assert.equal(remove.status, 409, id);
    assert.equal(await errorCode(remove), 'ROLE_PROTECTED');
  }
  const person = await staffWith([]);
  const assign = await call(
    'PUT',
    `/v1/ops/staff/${person.userId}/role`,
    owner.cookie,
    { roleId: 'release_check', reason: REASON },
  );
  assert.equal(assign.status, 409);
  assert.equal(await errorCode(assign), 'ROLE_PROTECTED');
});

test('owner holds every permission from code, ignores adjustments, and adjustments on an owner are refused', async () => {
  const second = await staffSignIn('+2348036667901');
  const secondId = await userIdOf(second);
  const refused = await call(
    'PUT',
    `/v1/ops/staff/${secondId}/access`,
    owner.cookie,
    { additions: [], removals: ['audit.view'], reason: REASON },
  );
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'STAFF_PROTECTED');

  // A stored row must not lower an owner, and a missing role_permissions row must not either.
  await database.pool.query(
    `INSERT INTO staff_permission_overrides (user_id, permission, effect, granted_by)
     VALUES ($1, 'audit.view', 'remove', $1)`,
    [secondId],
  );
  await database.pool.query(
    `DELETE FROM role_permissions WHERE role_id = 'owner' AND permission = 'staff.manage'`,
  );
  const held = await staffPermissions(database.db, secondId);
  assert.deepEqual(sorted(held), [...OPS_PERMISSIONS].sort());
  const access = await effectiveAccess(database.db, secondId);
  assert.deepEqual(access.removals, []);
  assert.equal(access.roleId, 'owner');
  await database.pool.query(
    `INSERT INTO role_permissions (role_id, permission) VALUES ('owner', 'staff.manage')`,
  );
});

test('a role with people on it cannot be deleted; an empty one can', async () => {
  const person = await staffWith([]);
  const refused = await call(
    'POST',
    `/v1/ops/staff/roles/${person.roleId}/delete`,
    owner.cookie,
    { reason: REASON },
  );
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'ROLE_IN_USE');

  const empty = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Short lived'),
    description: '',
    permissions: ['audit.view'],
    reason: REASON,
  });
  const removed = await call(
    'POST',
    `/v1/ops/staff/roles/${empty.id}/delete`,
    owner.cookie,
    { reason: REASON },
  );
  assert.equal(removed.status, 200);
  const roles = await dataOf(
    await call('GET', '/v1/ops/staff/roles', owner.cookie),
  );
  assert.equal(
    roles.some((role) => role.id === empty.id),
    false,
  );
});

test('additions and removals apply, and survive a role change', async () => {
  const person = await staffWith(['issues.view', 'search.view']);
  const set = await call(
    'PUT',
    `/v1/ops/staff/${person.userId}/access`,
    owner.cookie,
    { additions: ['audit.view'], removals: ['search.view'], reason: REASON },
  );
  assert.equal(set.status, 200);
  const access = await dataOf(
    await call('GET', `/v1/ops/staff/${person.userId}/access`, owner.cookie),
  );
  assert.deepEqual(access, {
    roleId: person.roleId,
    permissions: ['audit.view', 'issues.view'],
    additions: ['audit.view'],
    removals: ['search.view'],
  });

  const next = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Next'),
    description: '',
    permissions: ['search.view', 'analytics.view'],
    reason: REASON,
  });
  const moved = await call(
    'PUT',
    `/v1/ops/staff/${person.userId}/role`,
    owner.cookie,
    { roleId: next.id, reason: REASON },
  );
  assert.equal(moved.status, 200);
  const after = await effectiveAccess(database.db, person.userId);
  assert.deepEqual(after, {
    roleId: next.id,
    permissions: ['analytics.view', 'audit.view'],
    additions: ['audit.view'],
    removals: ['search.view'],
  });
});

test('the same permission cannot be both added and removed, and unknown names are refused', async () => {
  const person = await staffWith([]);
  const both = await call(
    'PUT',
    `/v1/ops/staff/${person.userId}/access`,
    owner.cookie,
    { additions: ['audit.view'], removals: ['audit.view'], reason: REASON },
  );
  assert.equal(both.status, 400);
  const unknown = await call(
    'PUT',
    `/v1/ops/staff/${person.userId}/access`,
    owner.cookie,
    { additions: ['nope.nope'], removals: [], reason: REASON },
  );
  assert.equal(unknown.status, 400);
  await assert.rejects(
    setPersonalAccess(database.db, {
      actorId: ownerId,
      userId: person.userId,
      additions: ['nope.nope'],
      removals: [],
      reason: REASON,
    }),
    { code: 'INVALID_INPUT' },
  );
});

test('a permission removed mid-session gives 403 on the next request', async () => {
  const person = await staffWith(['audit.view']);
  assert.equal((await call('GET', '/v1/ops/audit', person.cookie)).status, 200);
  const removed = await call(
    'PUT',
    `/v1/ops/staff/${person.userId}/access`,
    owner.cookie,
    { additions: [], removals: ['audit.view'], reason: REASON },
  );
  assert.equal(removed.status, 200);
  assert.equal((await call('GET', '/v1/ops/audit', person.cookie)).status, 403);

  // Same again through the role, and through a role change.
  const other = await staffWith(['audit.view']);
  assert.equal((await call('GET', '/v1/ops/audit', other.cookie)).status, 200);
  await updateRole(database.db, {
    actorId: ownerId,
    roleId: other.roleId,
    permissions: [],
    reason: REASON,
  });
  assert.equal((await call('GET', '/v1/ops/audit', other.cookie)).status, 403);
  const me = await dataOf(await call('GET', '/v1/ops/me', other.cookie));
  assert.deepEqual(me.permissions, []);
});

test('staff routes need staff.manage', async () => {
  const person = await staffWith(['audit.view']);
  for (const [method, path, body] of [
    ['GET', '/v1/ops/staff/roles'],
    ['POST', '/v1/ops/staff/roles', { name: 'Nope nope', reason: REASON }],
    ['GET', `/v1/ops/staff/${ownerId}/access`],
    [
      'PUT',
      `/v1/ops/staff/${person.userId}/access`,
      { additions: ['staff.manage'], removals: [], reason: REASON },
    ],
  ]) {
    assert.equal(
      (await call(method, path, person.cookie, body)).status,
      403,
      `${method} ${path}`,
    );
  }
  const { cookie } = await signIn(stack.api, '+2348036667902');
  assert.equal((await call('GET', '/v1/ops/staff/roles', cookie)).status, 404);
});

test('the operations re-check the actor themselves, not only the route', async () => {
  const person = await staffWith(['audit.view']);
  const target = await staffWith([]);
  const refused = { code: 'PERMISSION_NOT_HELD' };
  await assert.rejects(
    createRole(database.db, {
      actorId: person.userId,
      name: uniqueName('Sneak'),
      description: '',
      permissions: [],
      reason: REASON,
    }),
    refused,
  );
  await assert.rejects(
    setPersonalAccess(database.db, {
      actorId: person.userId,
      userId: target.userId,
      additions: ['audit.view'],
      removals: [],
      reason: REASON,
    }),
    refused,
  );
  await assert.rejects(
    deleteRole(database.db, {
      actorId: '00000000-0000-7000-8000-000000000000',
      roleId: target.roleId,
      reason: REASON,
    }),
    refused,
  );
});

test('granting a permission you do not hold is refused, on every path', async () => {
  const manager = await staffWith(['staff.manage', 'issues.view']);
  const target = await staffWith([]);
  const refuses = async (response, label) => {
    assert.equal(response.status, 403, label);
    assert.equal(await errorCode(response), 'PERMISSION_NOT_HELD', label);
  };

  await refuses(
    await call('POST', '/v1/ops/staff/roles', manager.cookie, {
      name: uniqueName('Grab'),
      permissions: ['issues.view', 'audit.view'],
      reason: REASON,
    }),
    'create',
  );
  await refuses(
    await call(
      'PATCH',
      `/v1/ops/staff/roles/${target.roleId}`,
      manager.cookie,
      { permissions: ['audit.view'], reason: REASON },
    ),
    'edit',
  );
  const senior = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Senior'),
    description: '',
    permissions: ['issues.view', 'audit.view'],
    reason: REASON,
  });
  await refuses(
    await call('PUT', `/v1/ops/staff/${target.userId}/role`, manager.cookie, {
      roleId: senior.id,
      reason: REASON,
    }),
    'assign',
  );
  await refuses(
    await call('PUT', `/v1/ops/staff/${target.userId}/access`, manager.cookie, {
      additions: ['audit.view'],
      removals: [],
      reason: REASON,
    }),
    'addition',
  );
  // Only an owner can make an owner, whatever the manager holds.
  await refuses(
    await call('PUT', `/v1/ops/staff/${target.userId}/role`, manager.cookie, {
      roleId: 'owner',
      reason: REASON,
    }),
    'owner',
  );

  // What the manager does hold goes through, by role, and personally.
  const held = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Held'),
    description: '',
    permissions: ['issues.view'],
    reason: REASON,
  });
  assert.equal(
    (
      await call('PUT', `/v1/ops/staff/${target.userId}/role`, manager.cookie, {
        roleId: held.id,
        reason: REASON,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        'PUT',
        `/v1/ops/staff/${target.userId}/access`,
        manager.cookie,
        { additions: [], removals: ['issues.view'], reason: REASON },
      )
    ).status,
    200,
  );
});

test('a personal removal on the actor means they no longer hold it', async () => {
  const manager = await staffWith(['staff.manage', 'audit.view']);
  const target = await staffWith([]);
  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: manager.userId,
    additions: [],
    removals: ['audit.view'],
    reason: REASON,
  });
  const refused = await call(
    'PUT',
    `/v1/ops/staff/${target.userId}/access`,
    manager.cookie,
    { additions: ['audit.view'], removals: [], reason: REASON },
  );
  assert.equal(refused.status, 403);
});

test('removing a permission you do not hold is refused, so nobody lowers someone more senior', async () => {
  const manager = await staffWith(['staff.manage', 'issues.view']);
  const senior = await staffWith(['audit.view', 'issues.view']);
  const refuses = async (response, label) => {
    assert.equal(response.status, 403, label);
    assert.equal(await errorCode(response), 'PERMISSION_NOT_HELD', label);
  };

  await refuses(
    await call('PUT', `/v1/ops/staff/${senior.userId}/access`, manager.cookie, {
      additions: [],
      removals: ['audit.view'],
      reason: REASON,
    }),
    'personal removal',
  );
  await refuses(
    await call(
      'PATCH',
      `/v1/ops/staff/roles/${senior.roleId}`,
      manager.cookie,
      { permissions: ['issues.view'], reason: REASON },
    ),
    'role edit',
  );
  const lesser = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Lesser'),
    description: '',
    permissions: ['issues.view'],
    reason: REASON,
  });
  await refuses(
    await call('PUT', `/v1/ops/staff/${senior.userId}/role`, manager.cookie, {
      roleId: lesser.id,
      reason: REASON,
    }),
    'role change',
  );

  // Clearing someone's personal removal gives them the permission back: a grant.
  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: senior.userId,
    additions: [],
    removals: ['audit.view'],
    reason: REASON,
  });
  await refuses(
    await call('PUT', `/v1/ops/staff/${senior.userId}/access`, manager.cookie, {
      additions: [],
      removals: [],
      reason: REASON,
    }),
    'clearing a removal',
  );
  // A personal addition the manager doesn't hold can't be taken away by leaving it off.
  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: senior.userId,
    additions: ['private.view'],
    removals: ['audit.view'],
    reason: REASON,
  });
  await refuses(
    await call('PUT', `/v1/ops/staff/${senior.userId}/access`, manager.cookie, {
      additions: [],
      removals: ['audit.view'],
      reason: REASON,
    }),
    'dropping an addition',
  );
  // Leaving what the manager can't touch as it was, and changing what they hold, is fine.
  assert.equal(
    (
      await call(
        'PUT',
        `/v1/ops/staff/${senior.userId}/access`,
        manager.cookie,
        {
          additions: ['private.view'],
          removals: ['audit.view', 'issues.view'],
          reason: REASON,
        },
      )
    ).status,
    200,
  );
  assert.deepEqual(
    await staffPermissions(database.db, senior.userId).then(sorted),
    ['private.view'],
  );
});

test('a manager cannot demote or adjust an owner, even holding every permission', async () => {
  // Another owner, so the last-owner rule isn't what answers.
  await staffSignIn('+2348036667999');
  const manager = await staffWith([...OPS_PERMISSIONS]);
  const lesser = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Demoted'),
    description: '',
    permissions: [...OPS_PERMISSIONS],
    reason: REASON,
  });
  const demote = await call(
    'PUT',
    `/v1/ops/staff/${ownerId}/role`,
    manager.cookie,
    { roleId: lesser.id, reason: REASON },
  );
  assert.equal(demote.status, 403);
  assert.equal(await errorCode(demote), 'PERMISSION_NOT_HELD');
  const adjust = await call(
    'PUT',
    `/v1/ops/staff/${ownerId}/access`,
    manager.cookie,
    { additions: [], removals: ['audit.view'], reason: REASON },
  );
  assert.equal(adjust.status, 409);
  assert.equal((await effectiveAccess(database.db, ownerId)).roleId, 'owner');
});

test('changing your own access is refused', async () => {
  const manager = await staffWith(['staff.manage', 'issues.view']);
  const refuses = async (response, label) => {
    assert.equal(response.status, 403, label);
    assert.equal(await errorCode(response), 'SELF_ACCESS_CHANGE', label);
  };
  await refuses(
    await call(
      'PUT',
      `/v1/ops/staff/${manager.userId}/access`,
      manager.cookie,
      {
        additions: ['issues.view'],
        removals: [],
        reason: REASON,
      },
    ),
    'personal',
  );
  const other = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Sideways'),
    description: '',
    permissions: ['issues.view'],
    reason: REASON,
  });
  await refuses(
    await call('PUT', `/v1/ops/staff/${manager.userId}/role`, manager.cookie, {
      roleId: other.id,
      reason: REASON,
    }),
    'role',
  );
  // Editing the role you are on changes your own access too, even only downwards.
  await refuses(
    await call(
      'PATCH',
      `/v1/ops/staff/roles/${manager.roleId}`,
      manager.cookie,
      { permissions: ['staff.manage'], reason: REASON },
    ),
    'own role edit',
  );
  await refuses(
    await call('PUT', `/v1/ops/staff/${ownerId}/access`, owner.cookie, {
      additions: [],
      removals: [],
      reason: REASON,
    }),
    'owner, self',
  );
});

test('two owners demoting each other at once: only one goes through', async () => {
  const first = await staffSignIn('+2348036667903');
  const second = await staffSignIn('+2348036667904');
  const [firstId, secondId] = await Promise.all([
    userIdOf(first),
    userIdOf(second),
  ]);
  const role = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Former owner'),
    description: '',
    permissions: ['staff.manage'],
    reason: REASON,
  });
  const results = await Promise.allSettled([
    changeRole(database.db, {
      actorId: firstId,
      userId: secondId,
      roleId: role.id,
      reason: REASON,
    }),
    changeRole(database.db, {
      actorId: secondId,
      userId: firstId,
      roleId: role.id,
      reason: REASON,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((r) => r.status === 'rejected').reason.code,
    'PERMISSION_NOT_HELD',
  );
  const roles = await Promise.all(
    [firstId, secondId].map(
      async (id) => (await effectiveAccess(database.db, id)).roleId,
    ),
  );
  assert.equal(roles.filter((r) => r === 'owner').length, 1);
});

test('editing a role says who is affected, and the dry run changes nothing', async () => {
  const one = await staffWith(['issues.view']);
  const two = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Unrelated'),
    description: '',
    permissions: [],
    reason: REASON,
  });
  // Already adds audit.view personally, so adding it to the role changes nothing for them.
  const peer = await staffSignIn('+2348036667905');
  const peerId = await userIdOf(peer);
  await changeRole(database.db, {
    actorId: ownerId,
    userId: peerId,
    roleId: one.roleId,
    reason: REASON,
  });
  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: peerId,
    additions: ['audit.view'],
    removals: [],
    reason: REASON,
  });

  const impact = await roleImpact(database.db, {
    roleId: one.roleId,
    permissions: ['audit.view'],
  });
  assert.deepEqual(impact.added, ['audit.view']);
  assert.deepEqual(impact.removed, ['issues.view']);
  const byId = new Map(impact.affected.map((p) => [p.userId, p]));
  assert.deepEqual(byId.get(one.userId).gains, ['audit.view']);
  assert.deepEqual(byId.get(one.userId).losses, ['issues.view']);
  assert.deepEqual(byId.get(peerId).gains, []);
  assert.deepEqual(byId.get(peerId).losses, ['issues.view']);
  assert.deepEqual(sorted(await staffPermissions(database.db, one.userId)), [
    'issues.view',
  ]);

  const dryRun = await call(
    'POST',
    `/v1/ops/staff/roles/${one.roleId}/impact`,
    owner.cookie,
    { permissions: ['audit.view'] },
  );
  assert.equal(dryRun.status, 200);
  assert.equal((await dataOf(dryRun)).affected.length, 2);

  const saved = await call(
    'PATCH',
    `/v1/ops/staff/roles/${one.roleId}`,
    owner.cookie,
    { permissions: ['audit.view'], reason: REASON },
  );
  const body = await dataOf(saved);
  assert.deepEqual(body.role.permissions, ['audit.view']);
  assert.equal(body.affected.length, 2);
  assert.equal(
    (
      await roleImpact(database.db, {
        roleId: two.id,
        permissions: ['audit.view'],
      })
    ).affected.length,
    0,
  );
});

test('every change writes an audit event with actor and reason', async () => {
  const seen = async () =>
    (await listAudit(database.db, { limit: 100 })).map((row) => row.seq)[0];
  const person = await staffWith([]);
  const created = await (async () => {
    const start = await seen();
    const role = await createRole(database.db, {
      actorId: ownerId,
      name: uniqueName('Audited'),
      description: 'For the audit test',
      permissions: [],
      reason: `${REASON} A`,
    });
    const rows = (await listAudit(database.db, { limit: 100 })).filter(
      (row) => row.seq > start,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'role.created');
    assert.equal(rows[0].staffUserId, ownerId);
    assert.equal(rows[0].permission, 'staff.manage');
    assert.equal(rows[0].subjectType, 'role');
    assert.equal(rows[0].subjectId, role.id);
    assert.equal(auditParts(rows[0]).text, `${REASON} A`);
    return role;
  })();

  for (const [action, subjectType, subjectId, reason, run] of [
    [
      'role.updated',
      'role',
      created.id,
      `${REASON} B`,
      (r) =>
        updateRole(database.db, {
          actorId: ownerId,
          roleId: created.id,
          permissions: ['audit.view'],
          reason: r,
        }),
    ],
    [
      'staff.role_changed',
      'user',
      person.userId,
      `${REASON} C`,
      (r) =>
        changeRole(database.db, {
          actorId: ownerId,
          userId: person.userId,
          roleId: created.id,
          reason: r,
        }),
    ],
    [
      'staff.access_changed',
      'user',
      person.userId,
      `${REASON} D`,
      (r) =>
        setPersonalAccess(database.db, {
          actorId: ownerId,
          userId: person.userId,
          additions: [],
          removals: ['audit.view'],
          reason: r,
        }),
    ],
  ]) {
    const start = await seen();
    await run(reason);
    const rows = (await listAudit(database.db, { limit: 100 })).filter(
      (row) => row.seq > start,
    );
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].action, action);
    assert.equal(rows[0].staffUserId, ownerId);
    assert.equal(rows[0].subjectType, subjectType);
    assert.equal(rows[0].subjectId, subjectId);
    assert.equal(auditParts(rows[0]).text, reason);
  }

  const empty = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Audited empty'),
    description: '',
    permissions: [],
    reason: REASON,
  });
  const start = await seen();
  await deleteRole(database.db, {
    actorId: ownerId,
    roleId: empty.id,
    reason: `${REASON} E`,
  });
  const rows = (await listAudit(database.db, { limit: 100 })).filter(
    (row) => row.seq > start,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'role.deleted');
  assert.equal(auditParts(rows[0]).text, `${REASON} E`);

  // A reason is required, on the route and in the operation.
  assert.equal(
    (
      await call('POST', '/v1/ops/staff/roles', owner.cookie, {
        name: uniqueName('No reason'),
      })
    ).status,
    400,
  );
  await assert.rejects(
    createRole(database.db, {
      actorId: ownerId,
      name: uniqueName('Blank reason'),
      description: '',
      permissions: [],
      reason: '         ',
    }),
    { code: 'INVALID_INPUT' },
  );
  // A refused change leaves no audit row and no change.
  const before = await seen();
  await assert.rejects(
    deleteRole(database.db, {
      actorId: ownerId,
      roleId: created.id,
      reason: REASON,
    }),
    { code: 'ROLE_IN_USE' },
  );
  assert.equal(await seen(), before);
});

test('the migration creates the starter roles, editable and without staff management', async () => {
  const name = `tipme_roles_starter_${process.pid}`;
  await database.pool.query(`DROP DATABASE IF EXISTS ${name}`);
  await database.pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(database.url);
  url.pathname = `/${name}`;
  const fresh = createDatabase(url.toString());
  try {
    await runMigrations(fresh.db);
    const { rows } = await fresh.pool.query(
      `SELECT r.id, r.name, r.system, array_remove(array_agg(p.permission ORDER BY p.permission), NULL) AS permissions
       FROM roles r LEFT JOIN role_permissions p ON p.role_id = r.id
       GROUP BY r.id, r.name, r.system ORDER BY r.name`,
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    // Every starter role can edit the changelog and ask for approval (owner's default, 6 Nov 2026).
    assert.deepEqual(byName.get('Support').permissions, [
      'changelog.edit',
      'issues.resolve',
      'issues.view',
      'pages.suspend',
      'search.view',
    ]);
    assert.deepEqual(byName.get('Finance').permissions, [
      'analytics.view',
      'changelog.edit',
      'fees.manage',
      'issues.view',
      'payments.recheck',
      'search.view',
    ]);
    assert.deepEqual(byName.get('Marketing').permissions, [
      'analytics.view',
      'changelog.edit',
      'market.edit',
    ]);
    for (const starter of ['Support', 'Finance', 'Marketing']) {
      const row = byName.get(starter);
      assert.equal(row.system, false, starter);
      assert.match(row.id, /^[0-9a-f-]{36}$/);
      assert.equal(row.permissions.includes('staff.manage'), false);
    }
    assert.equal(byName.get('Owner').system, true);
    assert.equal(byName.get('Release check').system, true);
    // Only the owner publishes; release_check stays fixed.
    for (const [role, held] of [
      ['Owner', ['changelog.edit', 'changelog.publish']],
      ['Release check', []],
      ['Support', ['changelog.edit']],
    ])
      assert.deepEqual(
        (byName.get(role)?.permissions ?? []).filter((p) =>
          p.startsWith('changelog.'),
        ),
        held,
        role,
      );
  } finally {
    await fresh.close();
    await database.pool.query(`DROP DATABASE IF EXISTS ${name}`);
  }
});

test('an id in another case is still you: operations refuse, and the routes reject the form', async () => {
  // Alone among the owners would be the worst case, so check the count stays put as well.
  const before = await ownersActive();
  const self = owner;
  const upper = ownerId.toUpperCase();
  const role = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Case'),
    description: '',
    permissions: [],
    reason: REASON,
  });
  await assert.rejects(
    changeRole(database.db, {
      actorId: ownerId,
      userId: upper,
      roleId: role.id,
      reason: REASON,
    }),
    { code: 'SELF_ACCESS_CHANGE' },
  );
  await assert.rejects(
    changeRole(database.db, {
      actorId: upper,
      userId: ownerId,
      roleId: role.id,
      reason: REASON,
    }),
    { code: 'SELF_ACCESS_CHANGE' },
  );
  await assert.rejects(
    setPersonalAccess(database.db, {
      actorId: ownerId,
      userId: upper,
      additions: [],
      removals: [],
      reason: REASON,
    }),
    { code: 'SELF_ACCESS_CHANGE' },
  );
  const manager = await staffWith(['staff.manage', 'issues.view']);
  await assert.rejects(
    setPersonalAccess(database.db, {
      actorId: manager.userId,
      userId: manager.userId.toUpperCase(),
      additions: [],
      removals: ['issues.view'],
      reason: REASON,
    }),
    { code: 'SELF_ACCESS_CHANGE' },
  );

  for (const [path, body] of [
    [`/v1/ops/staff/${upper}/role`, { roleId: role.id, reason: REASON }],
    [
      `/v1/ops/staff/${upper}/access`,
      { additions: [], removals: [], reason: REASON },
    ],
    [`/v1/ops/staff/not-a-uuid/role`, { roleId: role.id, reason: REASON }],
  ]) {
    const response = await call('PUT', path, self.cookie, body);
    assert.equal(response.status, 404, path);
  }
  assert.equal(
    (await call('GET', `/v1/ops/staff/${upper}/access`, self.cookie)).status,
    404,
  );
  assert.equal((await effectiveAccess(database.db, ownerId)).roleId, 'owner');
  assert.equal(await ownersActive(), before);
});

test('a target named in another case is stored and audited in its one true form', async () => {
  const person = await staffWith(['issues.view']);
  await setPersonalAccess(database.db, {
    actorId: ownerId.toUpperCase(),
    userId: person.userId.toUpperCase(),
    additions: ['audit.view'],
    removals: [],
    reason: REASON,
  });
  const row = await newestAudit();
  assert.equal(row.subjectId, person.userId);
  assert.equal(row.staffUserId, ownerId);
});

test('audit rows say what changed', async () => {
  const name = uniqueName('Recorded');
  const role = await createRole(database.db, {
    actorId: ownerId,
    name,
    description: 'First words',
    permissions: ['issues.view', 'audit.view'],
    reason: REASON,
  });
  let parts = auditParts(await newestAudit());
  assert.equal(parts.text, REASON);
  assert.deepEqual(parts.change, {
    name,
    permissions: ['audit.view', 'issues.view'],
  });

  const renamed = uniqueName('Recorded again');
  await updateRole(database.db, {
    actorId: ownerId,
    roleId: role.id,
    name: renamed,
    description: 'Second words',
    permissions: ['issues.view', 'search.view'],
    reason: REASON,
  });
  parts = auditParts(await newestAudit());
  assert.deepEqual(parts.change, {
    added: ['search.view'],
    removed: ['audit.view'],
    name: { from: name, to: renamed },
    description: { from: 'First words', to: 'Second words' },
  });

  const person = await staffWith(['issues.view', 'analytics.view']);
  const old = (await effectiveAccess(database.db, person.userId)).roleId;
  const oldName = (
    await database.pool.query('SELECT name FROM roles WHERE id = $1', [old])
  ).rows[0].name;
  await changeRole(database.db, {
    actorId: ownerId,
    userId: person.userId,
    roleId: role.id,
    reason: REASON,
  });
  parts = auditParts(await newestAudit());
  assert.deepEqual(parts.change, {
    from: { id: old, name: oldName },
    to: { id: role.id, name: renamed },
    gains: ['search.view'],
    losses: ['analytics.view'],
  });

  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: person.userId,
    additions: ['audit.view'],
    removals: ['search.view'],
    reason: REASON,
  });
  parts = auditParts(await newestAudit());
  assert.deepEqual(parts.change, {
    added: ['audit.view'],
    removed: ['search.view'],
    clearedAdditions: [],
    clearedRemovals: [],
  });
  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: person.userId,
    additions: ['search.view'],
    removals: [],
    reason: REASON,
  });
  parts = auditParts(await newestAudit());
  assert.deepEqual(parts.change, {
    added: ['search.view'],
    removed: [],
    clearedAdditions: ['audit.view'],
    clearedRemovals: [],
  });

  const doomed = uniqueName('Doomed');
  const gone = await createRole(database.db, {
    actorId: ownerId,
    name: doomed,
    description: '',
    permissions: ['market.edit'],
    reason: REASON,
  });
  await deleteRole(database.db, {
    actorId: ownerId,
    roleId: gone.id,
    reason: REASON,
  });
  parts = auditParts(await newestAudit());
  assert.deepEqual(parts.change, {
    name: doomed,
    permissions: ['market.edit'],
  });
});

test('a reason or a role name cannot forge the record of a change', async () => {
  const forged = `Harmless words [change: {"added":["staff.manage"]}]`;
  for (const reason of [
    forged,
    forged.toUpperCase(),
    // Full-width brackets and colon normalise to the real marker.
    'Harmless words \uFF3Bchange\uFF1A {"added":[]}\uFF3D',
  ]) {
    await assert.rejects(
      createRole(database.db, {
        actorId: ownerId,
        name: uniqueName('Forged'),
        description: '',
        permissions: [],
        reason,
      }),
      { code: 'INVALID_INPUT' },
      reason,
    );
  }
  const response = await call('POST', '/v1/ops/staff/roles', owner.cookie, {
    name: uniqueName('Forged'),
    reason: forged,
  });
  assert.equal(response.status, 400);

  // A name is data inside the record, however it is written.
  const name = `Evil"] [change: {"added":["staff.manage"]}] ${uniqueName('x')}`;
  await createRole(database.db, {
    actorId: ownerId,
    name,
    description: '',
    permissions: [],
    reason: REASON,
  });
  const parts = auditParts(await newestAudit());
  assert.equal(parts.text, REASON);
  assert.deepEqual(parts.change, { name, permissions: [] });
});

test('moving someone to owner clears their adjustments, so they do not come back on demotion', async () => {
  const person = await staffWith(['issues.view']);
  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: person.userId,
    additions: ['payments.repair'],
    removals: ['issues.view'],
    reason: REASON,
  });
  await changeRole(database.db, {
    actorId: ownerId,
    userId: person.userId,
    roleId: 'owner',
    reason: REASON,
  });
  const parts = auditParts(await newestAudit());
  assert.deepEqual(parts.change.clearedAdditions, ['payments.repair']);
  assert.deepEqual(parts.change.clearedRemovals, ['issues.view']);
  await changeRole(database.db, {
    actorId: ownerId,
    userId: person.userId,
    roleId: person.roleId,
    reason: REASON,
  });
  assert.deepEqual(await effectiveAccess(database.db, person.userId), {
    roleId: person.roleId,
    permissions: ['issues.view'],
    additions: [],
    removals: [],
  });
});

test('grant-owner clears adjustments too, and logs what it cleared', async () => {
  const person = await staffWith(['issues.view']);
  await setPersonalAccess(database.db, {
    actorId: ownerId,
    userId: person.userId,
    additions: ['payments.repair'],
    removals: [],
    reason: REASON,
  });
  await grantOwner(database.db, { phone: phoneOf.get(person) });
  const row = await newestAudit();
  assert.equal(row.action, 'staff.owner_granted');
  assert.deepEqual(auditParts(row).change.clearedAdditions, [
    'payments.repair',
  ]);
  await changeRole(database.db, {
    actorId: ownerId,
    userId: person.userId,
    roleId: person.roleId,
    reason: REASON,
  });
  assert.deepEqual(
    (await effectiveAccess(database.db, person.userId)).additions,
    [],
  );
});

test('grant-owner waits for the staff-admin lock, then still works and is logged', async () => {
  const person = await staffWith([]);
  const client = await database.pool.connect();
  let finished = false;
  let granting;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`,
    );
    granting = grantOwner(database.db, {
      phone: phoneOf.get(person),
    }).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(finished, false, 'grant-owner ran inside the lock');
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const result = await granting;
  assert.match(result.enrolmentCode, /^[A-Z2-7]{10}$/);
  assert.equal(
    (await effectiveAccess(database.db, person.userId)).roleId,
    'owner',
  );
  const row = await newestAudit();
  assert.equal(row.action, 'staff.owner_granted');
  assert.equal(row.subjectId, person.userId);
});

test('a role change does not overwrite a role that changed after it was read', async () => {
  const person = await staffWith([]);
  const next = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Late'),
    description: '',
    permissions: [],
    reason: REASON,
  });
  // A writer outside the lock holds the row, so changeRole reads the old role and queues.
  const client = await database.pool.connect();
  let moving;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE staff SET role_id = 'owner' WHERE user_id = $1`,
      [person.userId],
    );
    moving = changeRole(database.db, {
      actorId: ownerId,
      userId: person.userId,
      roleId: next.id,
      reason: REASON,
    });
    moving.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await assert.rejects(moving, { code: 'STAFF_CHANGED' });
  assert.equal(
    (await effectiveAccess(database.db, person.userId)).roleId,
    'owner',
  );
});

test('deleting a role needs its permissions held', async () => {
  const manager = await staffWith(['staff.manage', 'issues.view']);
  const strong = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Strong'),
    description: '',
    permissions: ['issues.view', 'payments.repair'],
    reason: REASON,
  });
  const refused = await call(
    'POST',
    `/v1/ops/staff/roles/${strong.id}/delete`,
    manager.cookie,
    { reason: REASON },
  );
  assert.equal(refused.status, 403);
  assert.equal(await errorCode(refused), 'PERMISSION_NOT_HELD');
  const weak = await createRole(database.db, {
    actorId: ownerId,
    name: uniqueName('Weak'),
    description: '',
    permissions: ['issues.view'],
    reason: REASON,
  });
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/staff/roles/${weak.id}/delete`,
        manager.cookie,
        { reason: REASON },
      )
    ).status,
    200,
  );
});

test('a body cannot name the actor or the target', async () => {
  const person = await staffWith([]);
  for (const [method, path, body] of [
    [
      'POST',
      '/v1/ops/staff/roles',
      { name: uniqueName('Spoof'), reason: REASON, actorId: person.userId },
    ],
    [
      'PUT',
      `/v1/ops/staff/${person.userId}/access`,
      { additions: [], removals: [], reason: REASON, userId: ownerId },
    ],
    [
      'PUT',
      `/v1/ops/staff/${person.userId}/role`,
      { roleId: person.roleId, reason: REASON, actorId: person.userId },
    ],
  ]) {
    const response = await call(method, path, owner.cookie, body);
    assert.equal(response.status, 400, path);
  }
});
