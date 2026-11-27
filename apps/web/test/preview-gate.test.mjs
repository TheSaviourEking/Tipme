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

test('the preview password does not hold the manifest or the icons', () => {
  for (const path of [
    '/manifest.webmanifest',
    '/icons/favicon-32.png',
    '/icons/favicon-48.png',
    '/icons/apple-touch-icon.png',
    '/icons/192.png',
    '/icons/512-maskable.png',
  ])
    assert.equal(decide(path, undefined), 'exempt', path);
  for (const path of [
    '/icons/64.png',
    '/icons/../dashboard',
    '/icons/%2e%2e/x',
    '/manifest.webmanifest/x',
    '/icons/192.png/x',
    '/icons/favicon-64.png',
    // The old drawn icons are gone.
    '/icon.svg',
    '/apple-icon',
  ])
    assert.equal(decide(path, undefined), 'login', path);
});

// Emails load the logo from the web origin; a mail client has no preview ticket.
test('the preview password does not hold the email logos', () => {
  for (const scheme of ['light', 'dark'])
    for (const scale of ['2x', '3x'])
      // The old names stay open for emails already sent; the new logo has its own.
      for (const name of ['tipme-logo', 'tipme-logo-2026'])
        assert.equal(
          decide(`/email/${name}-${scheme}-${scale}.png`, undefined),
          'exempt',
          `${name} ${scheme} ${scale}`,
        );
  for (const path of [
    '/email',
    '/email/',
    '/email/other.png',
    '/email/tipme-logo-light.svg',
    '/email/tipme-logo-light-2x.png/x',
    '/email/tipme-logo-2027-light-2x.png',
    '/email/tipme-logo-2026-light-1x.png',
    '/email/../dashboard',
    '/email/%2e%2e/x',
    '/email//tipme-logo-light-2x.png',
  ])
    assert.equal(decide(path, undefined), 'login', path);
});

// Self-hosting (26 Nov 2026): the edge's health check and the deploy's version check have no ticket.
// /api/version shows only the build id, which the API's public /health/release already shows.
test('/api/version is open without the password, exactly that path', () => {
  assert.equal(decide('/api/version', undefined), 'exempt');
  for (const path of [
    '/api/version/../dashboard',
    '/api/versions',
    '/api/version/x',
  ])
    assert.equal(decide(path, undefined), 'login', path);
});

// Self-hosted, Next's image optimiser fetches the picture from this same server with no headers at
// all, so no ticket: behind the gate every <Image> of a portrait or cover failed (500). These files
// are the repository's own public/ folder (public on GitHub), never anyone's data.
test('the public folder pictures the image optimiser reads are open, and nothing else there', () => {
  for (const path of [
    '/portraits/ada.webp',
    '/covers/vinyl.webp',
    '/illustrations/hero-phone.png',
    '/brand/tipme-wordmark-ink.png',
    '/pro/studio-preview.webp',
    '/covers/studio/a-b.svg',
  ])
    assert.equal(decide(path, undefined), 'exempt', path);
  for (const path of [
    // Pages that share a folder name with public/: still gated.
    '/pro',
    '/pro/',
    '/email/unsubscribed',
    '/portraits',
    '/portraits/ada',
    // Not a picture, or not one of those folders.
    '/portraits/ada.html',
    '/sounds/tip.wav',
    '/dashboard/ada.png',
    '/people/ada.png',
    // Tricks.
    '/portraits/../dashboard.png',
    '/portraits/%2e%2e/dashboard.png',
    '//portraits/ada.webp',
    '/portraits/ada.webp/',
  ])
    assert.equal(decide(path, undefined), 'login', path);
});
