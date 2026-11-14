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
    ['search.view', ['/ops/search', '/ops/users']],
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
    '/ops/users',
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
    '/ops/pages',
    '/ops/usernames',
    '/ops/staff',
  ]);
  assert.equal(
    opsMenu(['usernames.manage']).find((l) => l.href === '/ops/usernames')
      .label,
    'Usernames',
  );
});

test('Pages shows to a usernames.manage-only holder', () => {
  // Taking a username back starts from the page's card.
  assert.ok(hrefs(['usernames.manage']).includes('/ops/pages'));
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
      ['Issues', 'Search', 'People', 'Pages', 'Usernames'],
      ['Visibility', 'Market'],
      ['Providers', 'Email', 'Audit log'],
      ['Staff members', 'Roles', 'Your access'],
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
  assert.equal(
    opsMenuCurrent(links, '/ops/staff/people')?.label,
    'Staff members',
  );
  assert.equal(opsMenuCurrent(links, '/ops/users')?.label, 'People');
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
    ['Issues', 'Search', 'People', 'Pages', 'Usernames', 'Businesses'],
  );
});

test('Changelog sits in Email and records, after Audit log, for either changelog permission', () => {
  for (const permission of ['changelog.edit', 'changelog.publish'])
    assert.deepEqual(opsMenuGroups([permission]), [
      {
        label: null,
        links: [
          { href: '/ops', label: 'Overview' },
          { href: '/ops/approvals', label: 'Approvals' },
        ],
      },
      {
        label: 'Email and records',
        links: [{ href: '/ops/changelog', label: 'Changelog' }],
      },
      { label: 'Staff', links: [{ href: '/ops/staff', label: 'Your access' }] },
    ]);
  const records = opsMenuGroups([...OWNER, 'changelog.edit']).find(
    (group) => group.label === 'Email and records',
  );
  assert.deepEqual(
    records.links.map((link) => link.label),
    ['Providers', 'Email', 'Audit log', 'Changelog'],
  );
  assert.ok(!hrefs(OWNER).includes('/ops/changelog'));
  assert.equal(
    opsMenuCurrent(opsMenu(['changelog.edit']), '/ops/changelog/42')?.label,
    'Changelog',
  );
});

test('Prices (personal and Business Pro) sits in Work, after Usernames, only with pro.price', () => {
  assert.ok(!hrefs(['fees.manage']).includes('/ops/pro-price'));
  assert.deepEqual(
    opsMenuGroups(['pro.price', 'usernames.manage'])
      .find((group) => group.label === 'Work')
      ?.links.map((link) => link.label),
    ['Pages', 'Usernames', 'Prices'],
  );
});

// Feature switches (owner, 14 Nov 2026): beside Providers, the other settings page.
test('Switches sits in Email and records, after Providers, only with switches.manage', () => {
  assert.ok(!hrefs(['providers.manage']).includes('/ops/switches'));
  assert.deepEqual(
    opsMenuGroups(['switches.manage', 'providers.manage'])
      .find((group) => group.label === 'Email and records')
      ?.links.map((link) => link.label),
    ['Providers', 'Switches'],
  );
});

test('People sits in Work right after Search, for search.view only', () => {
  assert.ok(!hrefs(['analytics.view', 'staff.manage']).includes('/ops/users'));
  const work = opsMenuGroups(['search.view']).find(
    (group) => group.label === 'Work',
  );
  assert.deepEqual(work?.links, [
    { href: '/ops/search', label: 'Search' },
    { href: '/ops/users', label: 'People' },
  ]);
});
// Staff announcements (14 Nov 2026): with the email records, only for announcements.send.
test('Announcements sits in Email and records, after Changelog, only with announcements.send', () => {
  assert.ok(!hrefs(['changelog.publish']).includes('/ops/announcements'));
  assert.deepEqual(
    opsMenuGroups(['announcements.send', 'changelog.edit'])
      .find((group) => group.label === 'Email and records')
      ?.links.map((link) => link.label),
    ['Changelog', 'Announcements'],
  );
});

// Merge train 2: the three settings and records pages from #212 (Prices, under Work), #213
// (Announcements) and #216 (Switches), all at once for someone holding every permission.
test('Prices, Announcements and Switches all show for someone with every permission', () => {
  const groups = opsMenuGroups([
    'pro.price',
    'announcements.send',
    'switches.manage',
    'providers.manage',
    'changelog.edit',
  ]);
  const labels = (name) =>
    groups.find((group) => group.label === name)?.links.map((l) => l.label);
  assert.deepEqual(labels('Work'), ['Prices']);
  assert.deepEqual(labels('Email and records'), [
    'Providers',
    'Switches',
    'Changelog',
    'Announcements',
  ]);
});
