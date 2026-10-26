import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  launchDecision,
  legacyProfileTarget,
  parseProductionLaunchAt,
} from '../src/lib/production-launch.ts';

const targetIso = '2026-10-26T23:00:00Z';
const target = Date.parse(targetIso);

test('the Lagos midnight target is an explicit, exact instant', () => {
  assert.equal(parseProductionLaunchAt(targetIso), target);
  assert.equal(parseProductionLaunchAt('2026-10-27T00:00:00+01:00'), target);
  assert.equal(parseProductionLaunchAt(undefined), null);
  for (const invalid of [
    '',
    '2026-10-27T00:00:00',
    '27 October 2026 midnight',
    '2026-02-30T00:00:00Z',
    '2026-10-27T00:00:00+25:00',
  ])
    assert.throws(
      () => parseProductionLaunchAt(invalid),
      /PRODUCTION_LAUNCH_AT/,
    );
});

test('future launch rewrites user routes but leaves operational assets reachable', () => {
  const decide = (path) => launchDecision({ path, target, now: target - 1 });
  for (const path of ['/', '/@ada', '/dashboard', '/ops', '/people/ada'])
    assert.equal(decide(path), 'rewrite', path);
  for (const path of [
    '/coming-soon',
    '/coming-soon/opengraph-image',
    '/coming-soon/opengraph-image-abc123.png',
    '/api/revalidate',
    '/robots.txt',
    '/sitemap.xml',
    '/favicon.ico',
    '/icon.svg',
    '/opengraph-image',
  ])
    assert.equal(decide(path), 'exempt', path);
});

test('the launch instant and later pass through, and a stale direct holding URL goes home', () => {
  for (const now of [target, target + 1]) {
    assert.equal(launchDecision({ path: '/', target, now }), 'pass');
    assert.equal(
      launchDecision({ path: '/coming-soon', target, now }),
      'redirect-home',
    );
  }
  assert.equal(launchDecision({ path: '/', target: null, now: 0 }), 'pass');
  assert.equal(
    launchDecision({ path: '/coming-soon', target: null, now: 0 }),
    'redirect-home',
  );
});

test('path tricks cannot claim a countdown exemption', () => {
  for (const path of [
    '//coming-soon',
    '/coming-soon/../dashboard',
    '/coming%2dsoon',
    '/api/revalidate/../dashboard',
    '/coming-soon\\dashboard',
  ])
    assert.equal(
      launchDecision({ path, target, now: target - 1 }),
      'rewrite',
      path,
    );
});

test('legacy profile redirects run after launch and retain only the QR source marker', () => {
  assert.equal(
    legacyProfileTarget('/people/Ada', new URLSearchParams('src=qr&secret=x')),
    '/@ada?src=qr',
  );
  assert.equal(
    legacyProfileTarget('/people/not/a-handle', new URLSearchParams()),
    null,
  );
  assert.equal(legacyProfileTarget('/@ada', new URLSearchParams()), null);
});
