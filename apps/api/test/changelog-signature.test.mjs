import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { changelogSignatureValid } from '../dist/changelog/changelog-signature.js';

// Changelog plan, Task 2.2: CI signs `${timestamp}.${rawBody}` with HMAC-SHA256.
// The fixture is shared with the CI client's test (Task 3.1): the same secret, timestamp and body
// must give this exact hex there too.
const FIXTURE = {
  secret: 'changelog-fixture-secret-0123456789abcdef',
  timestamp: '1762430400',
  body: '{"environment":"production"}',
  hex: '83bc073c964544e44d06d1656e312492bfa12f9b041410a6ff4007e9894267ef',
};
const NOW = Number(FIXTURE.timestamp) * 1000;

const valid = (overrides = {}) =>
  changelogSignatureValid({
    secret: FIXTURE.secret,
    timestamp: FIXTURE.timestamp,
    signature: `sha256=${FIXTURE.hex}`,
    raw: Buffer.from(FIXTURE.body),
    now: NOW,
    ...overrides,
  });

const sign = (secret, timestamp, body) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

test('the pinned fixture signs the way CI does, and is accepted', () => {
  assert.equal(
    sign(FIXTURE.secret, FIXTURE.timestamp, FIXTURE.body),
    `sha256=${FIXTURE.hex}`,
  );
  assert.equal(valid(), true);
  // Within the window either side.
  assert.equal(valid({ now: NOW + 300_000 }), true);
  assert.equal(valid({ now: NOW - 300_000 }), true);
});

test('another secret is refused', () => {
  assert.equal(
    valid({ secret: 'another-secret-of-forty-characters-0000' }),
    false,
  );
  assert.equal(
    valid({
      signature: sign(
        'another-secret-of-forty-characters-0000',
        FIXTURE.timestamp,
        FIXTURE.body,
      ),
    }),
    false,
  );
});

test('a timestamp more than 300 s old or ahead is refused', () => {
  assert.equal(valid({ now: NOW + 301_000 }), false);
  assert.equal(valid({ now: NOW - 301_000 }), false);
});

test('a missing header is refused', () => {
  assert.equal(valid({ timestamp: undefined }), false);
  assert.equal(valid({ signature: undefined }), false);
  assert.equal(valid({ timestamp: '' }), false);
  assert.equal(valid({ signature: '' }), false);
});

test('a malformed signature or timestamp is refused', () => {
  for (const signature of [
    FIXTURE.hex,
    `sha1=${FIXTURE.hex}`,
    `sha256=${'z'.repeat(64)}`,
    `sha256=${FIXTURE.hex.slice(0, 62)}`,
    `sha256=${FIXTURE.hex}00`,
    `sha256=${FIXTURE.hex} `,
  ])
    assert.equal(valid({ signature }), false, signature);
  for (const timestamp of [
    '1762430400.5',
    '-1762430400',
    'abc',
    '1e9',
    ' 1762430400',
  ])
    assert.equal(valid({ timestamp }), false, timestamp);
});

test('an empty or missing secret is always refused', () => {
  assert.equal(valid({ secret: '' }), false);
  assert.equal(valid({ secret: undefined }), false);
  assert.equal(
    valid({ secret: '', signature: sign('', FIXTURE.timestamp, FIXTURE.body) }),
    false,
  );
});

test('a body changed by one byte is refused', () => {
  assert.equal(
    valid({
      raw: Buffer.from(FIXTURE.body.replace('production', 'productioN')),
    }),
    false,
  );
  assert.equal(valid({ raw: Buffer.from(`${FIXTURE.body} `) }), false);
});
