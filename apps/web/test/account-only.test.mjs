import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountOnlyRoute } from '../src/lib/account-only.ts';

// Business sign-up, Task D4: what a login with no page may open in the dashboard.

test("the business, settings, help, what's new and work stay where they are", () => {
  for (const path of [
    '/dashboard/business',
    '/dashboard/business/apply',
    '/dashboard/settings',
    '/dashboard/help',
    '/dashboard/whats-new',
    '/dashboard/work',
  ])
    assert.equal(accountOnlyRoute(path), null, path);
});

test('page-only addresses go to the business, never /sign-up', () => {
  for (const path of [
    '/dashboard',
    '/dashboard/tips',
    '/dashboard/qr',
    '/dashboard/earnings',
    '/dashboard/campaigns',
    '/dashboard/withdraw',
    '/dashboard/businessy',
  ])
    assert.equal(accountOnlyRoute(path), '/dashboard/business', path);
});

test('a login with only a manager invitation goes to Work, where it is answered', () => {
  assert.equal(
    accountOnlyRoute('/dashboard/tips', { manages: false }),
    '/dashboard/work',
  );
  assert.equal(accountOnlyRoute('/dashboard/work', { manages: false }), null);
});
