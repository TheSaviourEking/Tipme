import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rateLimitSubject } from '../dist/checkout/rate-limit.guard.js';

test('rate limit subjects: IPv4 as is, IPv6 by /64, IPv4-mapped as IPv4', () => {
  assert.equal(rateLimitSubject('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitSubject('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitSubject('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(
    rateLimitSubject('2001:0db8:0001:0002:ffff::9'),
    '2001:db8:1:2::/64',
  );
  assert.equal(rateLimitSubject('::1'), '0:0:0:0::/64');
  assert.equal(rateLimitSubject(undefined), 'unknown');
  assert.equal(rateLimitSubject('not an ip'), 'unknown');
});
