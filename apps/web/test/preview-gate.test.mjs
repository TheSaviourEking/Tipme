import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issuePreviewTicket } from '@tipme/domain';
import { gateDecision, safeReturnPath } from '../src/lib/preview-gate.ts';

const password = 'staging-preview-password-for-tests-only!';
const now = Date.now();
const decide = (path, ticket) => gateDecision({ path, ticket, password, now });

test('pages need a valid ticket; the login page, revalidation and static assets are exempt', () => {
  assert.equal(decide('/', undefined), 'login');
  assert.equal(decide('/dashboard', undefined), 'login');
  assert.equal(decide('/dev/inbox', undefined), 'login');
  assert.equal(decide('/', issuePreviewTicket(password, now)), 'pass');
  assert.equal(decide('/preview-login', undefined), 'exempt');
  assert.equal(decide('/api/revalidate', undefined), 'exempt');
  assert.equal(decide('/favicon.ico', undefined), 'exempt');
});

test('forged, expired or foreign tickets and path tricks still need the password (Review Focus 1)', () => {
  for (const ticket of [
    'nonsense',
    issuePreviewTicket('another-password-of-forty-characters!!', now),
    issuePreviewTicket(password, now - 13 * 3600_000),
  ])
    assert.equal(decide('/', ticket), 'login');
  for (const path of [
    '//preview-login',
    '/preview-login/../dashboard',
    '/api/revalidate/../../dashboard',
    '/preview%2dlogin',
  ])
    assert.equal(decide(path, undefined), 'login', path);
});

test('after signing in, only a path on this site is followed', () => {
  assert.equal(safeReturnPath('/@ada?src=qr'), '/@ada?src=qr');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '', null])
    assert.equal(safeReturnPath(bad), '/');
});

test('fix (final review): whitespace or control characters cannot turn the return path into another site', () => {
  for (const bad of [
    '/\t/evil.com',
    '/\n/evil.com',
    '/ /evil.com',
    '/\u0000/x',
  ])
    assert.equal(safeReturnPath(bad), '/', JSON.stringify(bad));
});
