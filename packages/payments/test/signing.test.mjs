import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signWebhook, verifySignature } from '../dist/index.js';

const secret = 'test-secret-that-is-at-least-32-chars!!';
const body = '{"id":"evt_1","type":"payment.succeeded"}';
const now = new Date('2026-10-18T12:00:00Z');
const at = (seconds) => new Date(now.getTime() + seconds * 1000);

test('a correctly signed body verifies', () => {
  assert.equal(
    verifySignature(
      Buffer.from(body),
      signWebhook(body, secret, now),
      secret,
      now,
    ),
    'ok',
  );
});

test('wrong secret, tampered body and garbled headers are bad signatures', () => {
  const header = signWebhook(body, secret, now);
  assert.equal(
    verifySignature(
      Buffer.from(body),
      header,
      'another-secret-that-is-32-chars-long!',
      now,
    ),
    'bad_signature',
  );
  assert.equal(
    verifySignature(Buffer.from(body.replace('1', '2')), header, secret, now),
    'bad_signature',
  );
  assert.equal(
    verifySignature(Buffer.from(body), 't=1760788800,v1=zz', secret, now),
    'bad_signature',
  );
  assert.equal(
    verifySignature(Buffer.from(body), 'v1=abcdef', secret, now),
    'bad_signature',
  );
});

test('timestamps more than 300 s old or ahead are stale', () => {
  assert.equal(
    verifySignature(
      Buffer.from(body),
      signWebhook(body, secret, at(-301)),
      secret,
      now,
    ),
    'stale',
  );
  assert.equal(
    verifySignature(
      Buffer.from(body),
      signWebhook(body, secret, at(301)),
      secret,
      now,
    ),
    'stale',
  );
  assert.equal(
    verifySignature(
      Buffer.from(body),
      signWebhook(body, secret, at(-299)),
      secret,
      now,
    ),
    'ok',
  );
});

test('a missing header is reported as such', () => {
  assert.equal(
    verifySignature(Buffer.from(body), undefined, secret, now),
    'missing_signature',
  );
});
