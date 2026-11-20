import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intentAddressKey } from '../dist/checkout/address-key.js';

const SECRET = 'x'.repeat(32);

test('an intent’s address key is a keyed hash of the rate-limit subject, never the address', () => {
  const key = intentAddressKey(SECRET, '203.0.113.7');
  assert.ok(key);
  assert.ok(!key.includes('203'));
  // The same subject gives the same key, mapped IPv4 included; another secret gives another.
  assert.equal(intentAddressKey(SECRET, '::ffff:203.0.113.7'), key);
  assert.notEqual(intentAddressKey('y'.repeat(32), '203.0.113.7'), key);
  assert.notEqual(intentAddressKey(SECRET, '203.0.113.8'), key);
  // One IPv6 /64 is one supporter, as the rate limit counts them.
  assert.equal(
    intentAddressKey(SECRET, '2001:db8:1:2::1'),
    intentAddressKey(SECRET, '2001:db8:1:2::ffff'),
  );
  // An unknown address gives no key, so nobody shares one.
  assert.equal(intentAddressKey(SECRET, undefined), undefined);
  assert.equal(intentAddressKey(SECRET, 'not-an-ip'), undefined);
});
