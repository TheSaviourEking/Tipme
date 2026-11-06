import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opsMenu, opsMenuCurrent, opsMenuGroups } from '../src/lib/ops-menu.ts';

const hrefs = (permissions) => opsMenu(permissions).map((link) => link.href);

test('someone with nothing still gets Overview, Approvals and their own access', () => {
  assert.deepEqual(hrefs([]), ['/ops', '/ops/approvals', '/ops/staff']);
});

test('each entry needs what its page reads', () => {
  const cases = [
    ['issues.view', ['/ops/issues', '/ops/providers', '/ops/email']],
    ['analytics.view', ['/ops/visibility', '/ops/market']],
    ['pages.plan', ['/ops/pages']],
    ['fees.manage', ['/ops/pages']],
    ['payouts.resolve', ['/ops/pages']],
    ['recoveries.manage', ['/ops/pages']],
    ['search.view', ['/ops/search']],
    ['audit.view', ['/ops/audit']],
    ['staff.manage', ['/ops/staff/people', '/ops/staff/roles']],
  ];
  for (const [permission, expected] of cases)
    for (const href of expected)
      assert.ok(hrefs([permission]).includes(href), `${permission} → ${href}`);
});

test('a permission opens nothing else', () => {
  assert.deepEqual(hrefs(['search.view']), [
    '/ops',
    '/ops/approvals',
    '/ops/search',
    '/ops/staff',
  ]);
  assert.ok(!hrefs(['issues.view']).includes('/ops/staff/people'));
});

test('each permission for a screen opens that screen', () => {
  assert.ok(hrefs(['providers.manage']).includes('/ops/providers'));
  assert.ok(hrefs(['email.read']).includes('/ops/email'));
  assert.ok(hrefs(['email.export']).includes('/ops/email'));
  assert.ok(!hrefs(['email.read']).includes('/ops/providers'));
});

test('labels are unique, so a screen reader can tell them apart', () => {
  const labels = opsMenu([
    'issues.view',
    'analytics.view',
    'pages.plan',
    'search.view',
    'audit.view',
    'staff.manage',
  ]).map((link) => link.label);
  assert.equal(new Set(labels).size, labels.length);
});

test('Usernames appears only with usernames.manage, right after Pages', () => {
  assert.ok(!hrefs(['pages.plan', 'search.view']).includes('/ops/usernames'));
  const menu = hrefs(['pages.plan', 'usernames.manage']);
  assert.equal(menu[menu.indexOf('/ops/pages') + 1], '/ops/usernames');
  assert.deepEqual(hrefs(['usernames.manage']), [
    '/ops',
    '/ops/approvals',
    '/ops/usernames',
    '/ops/staff',
  ]);
  assert.equal(
    opsMenu(['usernames.manage']).find((l) => l.href === '/ops/usernames')
      .label,
    'Usernames',
  );
});

test('Businesses shows for search.view only while the business feature is on', () => {
  assert.ok(!hrefs(['search.view']).includes('/ops/businesses'));
  assert.ok(
    opsMenu(['search.view'], { business: true })
      .map((link) => link.href)
      .includes('/ops/businesses'),
  );
  assert.ok(
    !opsMenu(['analytics.view'], { business: true })
      .map((link) => link.href)
      .includes('/ops/businesses'),
  );
});

const OWNER = [
  'issues.view',
  'analytics.view',
  'pages.plan',
  'usernames.manage',
  'search.view',
  'providers.manage',
  'email.read',
  'audit.view',
  'staff.manage',
];

test('the menu comes in the board’s groups, in order', () => {
  const groups = opsMenuGroups(OWNER);
  assert.deepEqual(
    groups.map((group) => group.label),
    [null, 'Work', 'Numbers', 'Email and records', 'Staff'],
  );
  assert.deepEqual(
    groups.map((group) => group.links.map((link) => link.label)),
    [
      ['Overview', 'Approvals'],
      ['Issues', 'Search', 'Pages', 'Usernames'],
      ['Visibility', 'Market'],
      ['Providers', 'Email', 'Audit log'],
      ['People', 'Roles', 'Your access'],
    ],
  );
  // The flat menu is the groups read in order.
  assert.deepEqual(
    opsMenu(OWNER),
    groups.flatMap((group) => group.links),
  );
});

test('a group with nothing left is dropped', () => {
  assert.deepEqual(
    opsMenuGroups(['search.view']).map((group) => group.label),
    [null, 'Work', 'Staff'],
  );
  assert.deepEqual(
    opsMenuGroups([]).map((group) => group.label),
    [null, 'Staff'],
  );
});

test('the open page is its own link, or the section it sits in', () => {
  const links = opsMenu(OWNER);
  assert.equal(opsMenuCurrent(links, '/ops')?.label, 'Overview');
  assert.equal(opsMenuCurrent(links, '/ops/staff')?.label, 'Your access');
  assert.equal(opsMenuCurrent(links, '/ops/staff/people')?.label, 'People');
  assert.equal(opsMenuCurrent(links, '/ops/issues/abc')?.label, 'Issues');
  assert.equal(
    opsMenuCurrent(links, '/ops/providers/confirm')?.label,
    'Providers',
  );
  // Overview is never the section of another page.
  assert.equal(opsMenuCurrent(links, '/ops/nowhere'), null);
  // A page the menu doesn't offer this person has no link.
  assert.equal(opsMenuCurrent(opsMenu([]), '/ops/issues/abc'), null);
});

test('Businesses joins the Work group while the business feature is on', () => {
  assert.deepEqual(
    opsMenuGroups(OWNER, { business: true })
      .find((group) => group.label === 'Work')
      ?.links.map((link) => link.label),
    ['Issues', 'Search', 'Pages', 'Usernames', 'Businesses'],
  );
});
