import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRIVATE_PATHS,
  indexingEnabled,
  marketingRobots,
  robotsFor,
  sitemapFor,
} from '../src/lib/seo.ts';

const origin = 'https://www.usetipme.xyz';

test('while indexing is off (preview, pretend payments) crawlers are asked to stay out, and the sitemap is empty', () => {
  assert.deepEqual(robotsFor({ indexing: false, origin }), {
    rules: [{ userAgent: '*', disallow: '/' }],
  });
  assert.deepEqual(sitemapFor({ indexing: false, origin }), []);
});

test('once indexing is on, marketing pages are listed and private areas are always disallowed', () => {
  const robots = robotsFor({ indexing: true, origin });
  assert.equal(robots.sitemap, `${origin}/sitemap.xml`);
  const [rule] = robots.rules;
  assert.equal(rule.allow, '/');
  for (const path of [
    '/dashboard',
    '/ops',
    '/dev',
    '/mock-checkout',
    '/tip/',
    '/preview-login',
    '/api/',
    '/sign-in',
    '/sign-up',
    '/recover',
    '/verify-email',
  ])
    assert.ok(rule.disallow.includes(path), path);
  assert.deepEqual(rule.disallow, PRIVATE_PATHS);
  const urls = sitemapFor({ indexing: true, origin }).map((entry) => entry.url);
  assert.deepEqual(urls, [
    `${origin}/`,
    `${origin}/how-it-works`,
    `${origin}/for-creators`,
  ]);
  for (const url of urls)
    assert.equal(
      PRIVATE_PATHS.some((p) => new URL(url).pathname.startsWith(p)),
      false,
    );
});

test('indexing needs an explicit switch and is never on behind the preview password', () => {
  assert.equal(indexingEnabled({}), false);
  assert.equal(indexingEnabled({ SITE_INDEXING: 'on' }), true);
  assert.equal(
    indexingEnabled({ SITE_INDEXING: 'on', PREVIEW_PASSWORD: 'x' }),
    false,
  );
});

test('marketing metadata follows the indexing switch while remaining noindex by default', () => {
  assert.deepEqual(marketingRobots({}), { index: false, follow: false });
  assert.deepEqual(marketingRobots({ SITE_INDEXING: 'on' }), {
    index: true,
    follow: true,
  });
  assert.deepEqual(
    marketingRobots({ SITE_INDEXING: 'on', PREVIEW_PASSWORD: 'configured' }),
    { index: false, follow: false },
  );
});
