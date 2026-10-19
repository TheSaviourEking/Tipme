import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createStatusToken,
  verifyStatusToken,
} from '../dist/checkout/status-token.js';
import { loadApiConfig } from '../dist/config.js';

const secret = 's'.repeat(32);

test('status tokens verify only for their own tip and secret', () => {
  const tip = randomUUID();
  const token = createStatusToken(secret, tip);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(verifyStatusToken(secret, tip, token), true);
  assert.equal(verifyStatusToken(secret, randomUUID(), token), false);
  assert.equal(verifyStatusToken('t'.repeat(32), tip, token), false);
  assert.equal(verifyStatusToken(secret, tip, ''), false);
  const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  assert.equal(verifyStatusToken(secret, tip, flipped), false);
});

test('the status token secret is required', () => {
  assert.throws(
    () =>
      loadApiConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
        REDIS_URL: 'redis://127.0.0.1:6379',
        MOCK_PROVIDER_WEBHOOK_SECRET: 'x'.repeat(32),
      }),
    /STATUS_TOKEN_SECRET/,
  );
});
