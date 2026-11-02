import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  OPS_CATALOGUE,
  OPS_PERMISSIONS,
  OPS_PERMISSION_GROUPS,
  SERIOUS_ACTIONS,
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
  ]) {
    assert.equal(OPS_CATALOGUE[name].sensitive, true, name);
  }
});

test('the serious actions are the agreed ten', () => {
  assert.equal(new Set(SERIOUS_ACTIONS).size, 10);
  assert.ok(SERIOUS_ACTIONS.includes('staff.grant_owner'));
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
