import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STUDIO_EMBED_ORIGINS } from '@tipme/contracts';
import {
  PUBLIC_PAGE_SOURCE,
  contentSecurityPolicy,
} from '../src/lib/security-headers.ts';

// The Content-Security-Policy (threat model X1). Page Studio videos (plan Task 8) open in a frame
// after the visitor taps play; only the public page may frame, and only the allow-listed sites.

const API = 'https://api.tipme.example';
const directives = (csp) =>
  new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );

test('the CSP frames only the allow-listed embed origins, and only on the public page', () => {
  const page = directives(
    contentSecurityPolicy({ apiOrigin: API, dev: false, frames: true }),
  );
  assert.deepEqual(page.get('frame-src'), [...STUDIO_EMBED_ORIGINS]);
  assert.deepEqual([...STUDIO_EMBED_ORIGINS].sort(), [
    'https://audiomack.com',
    'https://www.tiktok.com',
    'https://www.youtube-nocookie.com',
  ]);
  // Everywhere else: no frame-src, so frames fall back to default-src 'self'.
  const elsewhere = directives(
    contentSecurityPolicy({ apiOrigin: API, dev: false, frames: false }),
  );
  assert.equal(elsewhere.has('frame-src'), false);
  assert.deepEqual(elsewhere.get('default-src'), ["'self'"]);
});

test('framing changes nothing else in the policy', () => {
  const base = directives(
    contentSecurityPolicy({ apiOrigin: API, dev: false, frames: false }),
  );
  const page = directives(
    contentSecurityPolicy({ apiOrigin: API, dev: false, frames: true }),
  );
  page.delete('frame-src');
  assert.deepEqual(page, base);
  assert.deepEqual(base.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(base.get('object-src'), ["'none'"]);
  assert.deepEqual(base.get('script-src'), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(base.get('img-src'), ["'self'", 'data:', 'blob:', API]);
  // No video site may be reached by a script, an image or a font: frames only.
  for (const [name, values] of base)
    for (const origin of STUDIO_EMBED_ORIGINS)
      assert.ok(!values.includes(origin), `${name} lists ${origin}`);
  assert.deepEqual(
    directives(
      contentSecurityPolicy({ apiOrigin: API, dev: true, frames: false }),
    ).get('script-src'),
    ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  );
});

test('next.config applies the framing policy to /@username only, after the site-wide one', () => {
  assert.equal(PUBLIC_PAGE_SOURCE, '/@:handle');
  const config = readFileSync(
    new URL('../next.config.ts', import.meta.url),
    'utf8',
  );
  const all = config.indexOf("source: '/:path*'");
  const pub = config.indexOf('source: PUBLIC_PAGE_SOURCE');
  // Next.js: when two entries set one header for a path, the later one wins.
  assert.ok(all > 0 && pub > all, 'the public page entry comes after /:path*');
});
