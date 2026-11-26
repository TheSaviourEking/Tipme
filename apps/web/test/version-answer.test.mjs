import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DRAIN_FILE, versionAnswer } from '../src/lib/version-answer.ts';

// The deploy marks the old production colour as draining before it stops it, so the edge moves page
// traffic to the new colour while the old one still serves the assets of pages it already sent.
test('a serving copy answers 200 with its version, never cached', () => {
  const { status, body, headers } = versionAnswer('abc123def456', false);
  assert.equal(status, 200);
  assert.deepEqual(body, { version: 'abc123def456' });
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('a draining copy answers 503, still naming its version', () => {
  const { status, body, headers } = versionAnswer('abc123def456', true);
  assert.equal(status, 503);
  assert.deepEqual(body, { version: 'abc123def456', draining: true });
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('the drain flag lives on the writable tmpfs', () => {
  assert.equal(DRAIN_FILE, '/tmp/tipme-draining');
});

// Prerendered, the route would answer the build's value for ever and never see the flag.
test('/api/version is read at request time and checks the drain flag', () => {
  const source = readFileSync(
    new URL('../src/app/api/version/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /await connection\(\)/);
  assert.match(source, /existsSync\(DRAIN_FILE\)/);
});
