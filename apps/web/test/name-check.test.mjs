import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NameChecks, nameCheckKey } from '../src/lib/name-check.ts';

test('nothing is checked before a bank is chosen and all 10 digits are in', () => {
  assert.equal(nameCheckKey('', '0123456789'), null);
  assert.equal(nameCheckKey('058', '012345678'), null);
  assert.equal(nameCheckKey('058', '01234567890'), null);
  assert.equal(nameCheckKey('058', '0123456789'), '058:0123456789');
  const checks = new NameChecks();
  assert.equal(checks.claim(null), false);
  assert.deepEqual(checks.view(null), { kind: 'waiting' });
});

test('a pair is checked once, and never again once answered', () => {
  const checks = new NameChecks();
  const key = nameCheckKey('058', '0123456789');
  assert.equal(checks.claim(key), true);
  assert.equal(checks.claim(key), false); // in flight
  assert.deepEqual(checks.view(key), { kind: 'checking' });
  checks.finish(key, { kind: 'found', accountName: 'ADA OKAFOR' });
  assert.equal(checks.claim(key), false);
  assert.deepEqual(checks.view(key), {
    kind: 'found',
    accountName: 'ADA OKAFOR',
  });
});

test('switching to another bank and back reuses the first answer', () => {
  const checks = new NameChecks();
  const gt = nameCheckKey('058', '0123456789');
  const ac = nameCheckKey('044', '0123456789');
  checks.claim(gt);
  checks.finish(gt, { kind: 'not_found' });
  assert.equal(checks.claim(ac), true);
  assert.equal(checks.claim(gt), false);
  assert.deepEqual(checks.view(gt), { kind: 'not_found' });
});

test('only a failure can be checked again', () => {
  const checks = new NameChecks();
  const key = nameCheckKey('058', '0123456789');
  checks.claim(key);
  checks.finish(key, { kind: 'not_found' });
  assert.equal(checks.retry(key), false);
  const other = nameCheckKey('058', '1111111111');
  checks.claim(other);
  assert.equal(checks.retry(other), false); // still in flight
  checks.finish(other, { kind: 'failed', code: 'PAYOUT_PROVIDER_UNAVAILABLE' });
  assert.equal(checks.claim(other), false); // a failure never re-fires by itself
  assert.equal(checks.retry(other), true);
  assert.deepEqual(checks.view(other), { kind: 'checking' });
});

test('a late answer is kept for its own pair only', () => {
  const checks = new NameChecks();
  const first = nameCheckKey('058', '0123456789');
  const second = nameCheckKey('058', '0123456788');
  checks.claim(first);
  checks.claim(second);
  checks.finish(first, { kind: 'found', accountName: 'ADA OKAFOR' });
  assert.deepEqual(checks.view(second), { kind: 'checking' });
  assert.deepEqual(checks.view(first), {
    kind: 'found',
    accountName: 'ADA OKAFOR',
  });
});
