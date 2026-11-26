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
  apiErrorCodes,
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

test('the serious actions are the agreed thirty-five', () => {
  // Fee waivers (spec 2026-11-23 §6) added `fee_waiver.set`.
  assert.equal(new Set(SERIOUS_ACTIONS).size, 35);
  // You collect staff screens (plan Task 15): every money action there needs collect.manage.
  for (const name of [
    'collect_transfer.retry',
    'collect_transfer.record_paid',
    'collect_dispute.release_hold',
    'collect_dispute.evidence',
    'collect_same_bank.clear',
    'tip_refund.record_paid',
  ])
    assert.equal(SERIOUS_ACTION_PERMISSIONS[name], 'collect.manage', name);
  assert.equal(OPS_CATALOGUE['collect.manage'].sensitive, true);
  assert.equal(OPS_CATALOGUE['collect.view'].sensitive, false);
  // Task 10 fix round 2 (RI1): money a failed collect refund took back goes back, with a second person.
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['tip_refund.return'],
    'payments.repair',
  );
  // You collect (plan Task 10, §6.1 case 3): TipMe absorbing what a refund can't take back.
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['tip_refund.absorb_gap'],
    'payments.repair',
  );
  // You collect (plan Task 13): a verified name changes only through support, with a second person.
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['collect_name.change'],
    'recoveries.manage',
  );
  // You collect (plan Task 12, spec §9, R11): its settings and staff's pause are money changes.
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['collect_settings.change'],
    'fees.manage',
  );
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['collect_transfers.pause'],
    'payments.repair',
  );
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['collect_transfers.resume'],
    'payments.repair',
  );
  // Owner, 18 Nov 2026: TipMe's fee per plan is a money change, with a second person.
  assert.equal(SERIOUS_ACTION_PERMISSIONS['plan_fees.change'], 'fees.manage');
  // Owner, 14 Nov 2026: a staff tip refund (the tip minus TipMe's fee) needs a second person.
  assert.equal(SERIOUS_ACTION_PERMISSIONS['tip.refund'], 'payments.repair');
  // Owner-change lock (14 Nov 2026): only TipMe removes a business owner, with a second person.
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['business.owner_remove'],
    'businesses.manage',
  );
  assert.equal(
    SERIOUS_ACTION_WORDS['business.owner_remove'],
    'Remove a business owner',
  );
  // Business Pro, plan Task A5: its own price, decided like the personal one.
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['business_pro_price.change'],
    'pro.price',
  );
  // Paid Pro, plan Task 9 (ruling 6): a card refund needs a second person.
  assert.equal(SERIOUS_ACTION_PERMISSIONS['pro.refund'], 'payments.repair');
  assert.ok(SERIOUS_ACTIONS.includes('business.verify'));
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['business.verify'],
    'businesses.manage',
  );
  assert.ok(SERIOUS_ACTIONS.includes('tip.reverse'));
  assert.equal(SERIOUS_ACTION_PERMISSIONS['tip.reverse'], 'payments.repair');
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

// Changelog plan (5 Nov 2026), Design §4.
test('changelog.edit is not sensitive; changelog.publish is, and names its serious action', () => {
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
  // 24 before; switches.manage (#216) and announcements.send (#213); collect.view and
  // collect.manage (You collect, Task 15).
  assert.equal(OPS_PERMISSIONS.length, 28);
  assert.ok(SERIOUS_ACTIONS.includes('changelog.publish'));
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['changelog.publish'],
    'changelog.publish',
  );
  assert.equal(
    SERIOUS_ACTION_WORDS['changelog.publish'],
    'Show users a What’s new entry',
  );
});

// Paid Pro (owner, 9 Nov 2026): staff set the Pro price; a change needs a second person.
test('pro.price is sensitive and in money; pro_price.change maps to it', () => {
  assert.equal(OPS_CATALOGUE['pro.price'].sensitive, true);
  assert.equal(OPS_CATALOGUE['pro.price'].group, 'money');
  assert.ok(SERIOUS_ACTIONS.includes('pro_price.change'));
  assert.equal(SERIOUS_ACTION_PERMISSIONS['pro_price.change'], 'pro.price');
  assert.match(SERIOUS_ACTION_WORDS['pro_price.change'], /Pro price/);
});

// Staff announcements (owner-approved, 14 Nov 2026): emailing many people needs a second person.
test('announcements.send is sensitive; announcement.send maps to it', () => {
  assert.equal(OPS_CATALOGUE['announcements.send'].sensitive, true);
  assert.equal(OPS_CATALOGUE['announcements.send'].group, 'content');
  assert.ok(SERIOUS_ACTIONS.includes('announcement.send'));
  assert.equal(
    SERIOUS_ACTION_PERMISSIONS['announcement.send'],
    'announcements.send',
  );
  assert.match(SERIOUS_ACTION_WORDS['announcement.send'], /announcement/i);
});

// Fee waivers (spec 2026-11-23 §6): who pays a fee is a money change, with a second person; a
// kind-wide TipMe-pays rule needs its estimated cost confirmed.
test('fee_waiver.set is a serious action on fees.manage, with its confirm error', () => {
  assert.ok(SERIOUS_ACTIONS.includes('fee_waiver.set'));
  assert.equal(SERIOUS_ACTION_PERMISSIONS['fee_waiver.set'], 'fees.manage');
  assert.equal(SERIOUS_ACTION_WORDS['fee_waiver.set'], 'Set who pays a fee');
  assert.equal(OPS_CATALOGUE['fees.manage'].sensitive, true);
  assert.ok(apiErrorCodes.includes('FEE_WAIVER_CONFIRM_REQUIRED'));
});
