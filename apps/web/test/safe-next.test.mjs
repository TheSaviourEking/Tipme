import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeNext } from '../src/lib/safe-next.ts';

const origin = 'http://localhost:3000';

test('fix: only paths on this site are followed after signing in', () => {
  for (const evil of [
    '/\\evil.com',
    '/\t/evil.com',
    '//evil.com',
    'https://evil.com',
    '/%5Cevil.com',
    'javascript:alert(1)',
    null,
    '',
  ])
    assert.equal(safeNext(evil, origin), '/dashboard', String(evil));
  assert.equal(
    safeNext('/dashboard/tips?status=paid', origin),
    '/dashboard/tips?status=paid',
  );
  assert.equal(safeNext('/dashboard/settings', origin), '/dashboard/settings');
});

test('staff can be sent back into the admin area, and only there besides the dashboard', () => {
  assert.equal(safeNext('/ops', origin), '/ops');
  assert.equal(
    safeNext('/ops/issues/0192?status=open', origin),
    '/ops/issues/0192?status=open',
  );
  for (const other of [
    '/opsx',
    '/ops.evil',
    '/people/ops',
    '/sign-in?next=/ops',
  ])
    assert.equal(safeNext(other, origin), '/dashboard', other);
});
