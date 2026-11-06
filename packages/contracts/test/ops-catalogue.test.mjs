import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  OPS_CATALOGUE,
  OPS_PERMISSIONS,
  OPS_PERMISSION_GROUPS,
  SERIOUS_ACTIONS,
  SERIOUS_ACTION_PERMISSIONS,
  SERIOUS_ACTION_WORDS,
} from '../dist/index.js';

const opsDir = new URL('../../../apps/api/src/ops/', import.meta.url);

test('every route names a permission in the catalogue', () => {
  let routes = 0;
  for (const file of readdirSync(opsDir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, opsDir), 'utf8');
    for (const [, name] of source.matchAll(/@OpsPermission\('([^']+)'\)/g)) {
      routes += 1;
      assert.ok(OPS_PERMISSIONS.includes(name), `${file}: ${name}`);
    }
  }
  assert.ok(routes > 40, 'the scan found the routes');
});

test('every catalogue entry has a description and group; money and private ones are sensitive', () => {
  assert.deepEqual(
    Object.keys(OPS_CATALOGUE).sort(),
    [...OPS_PERMISSIONS].sort(),
  );
  for (const [name, entry] of Object.entries(OPS_CATALOGUE)) {
    assert.ok(entry.description.length > 10, name);
    assert.ok(OPS_PERMISSION_GROUPS.includes(entry.group), name);
  }
  for (const name of [
    'audit.view',
    'payouts.resolve',
    'payments.repair',
    'fees.manage',
    'pages.plan',
    'private.view',
    'email.read',
    'email.export',
    'staff.manage',
    'usernames.manage',
  ]) {
    assert.equal(OPS_CATALOGUE[name].sensitive, true, name);
  }
});

// Reserving and releasing usernames is staff work on people (username reservation spec, section 4).
test('usernames.manage is a sensitive people permission', () => {
  assert.deepEqual(OPS_CATALOGUE['usernames.manage'], {
    description:
      'Reserve and release usernames, and ask to take one back from a page',
    group: 'people',
    sensitive: true,
  });
});

test('the serious actions are the agreed eleven', () => {
  assert.equal(new Set(SERIOUS_ACTIONS).size, 11);
  assert.ok(SERIOUS_ACTIONS.includes('staff.grant_owner'));
  assert.ok(SERIOUS_ACTIONS.includes('username.take_back'));
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['username.take_back'],
    'usernames.manage',
  );
  assert.equal(
    SERIOUS_ACTION_WORDS['username.take_back'],
    'Take a username back from a page',
  );
});

test('the runbook names every permission and serious action', () => {
  const runbook = readFileSync(
    new URL('../../../docs/runbooks/admin-roles.md', import.meta.url),
    'utf8',
  );
  for (const name of [...OPS_PERMISSIONS, ...SERIOUS_ACTIONS])
    assert.ok(runbook.includes(`\`${name}\``), `${name} is not in the runbook`);
  for (const rule of [
    /one person with a fresh code/,
    /Stopping takes no code/,
    /One admin alone/,
    /approves a regulatory/,
  ])
    assert.match(runbook, rule);
});

// Changelog plan (5 Nov 2026), Design §4. The serious action itself is registered with its
// approval flow in the admin API PR, so SERIOUS_ACTIONS stays at eleven until then.
test('changelog.edit is not sensitive; changelog.publish is, both under content', () => {
  assert.deepEqual(OPS_CATALOGUE['changelog.edit'], {
    description: 'Edit changelog entries and ask for one to be shown to users',
    group: 'content',
    sensitive: false,
  });
  assert.deepEqual(OPS_CATALOGUE['changelog.publish'], {
    description: 'Approve what users read in What’s new',
    group: 'content',
    sensitive: true,
  });
  assert.equal(OPS_PERMISSIONS.length, 22);
});
