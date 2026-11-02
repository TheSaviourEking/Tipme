import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opsMenu } from '../src/lib/ops-menu.ts';

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
