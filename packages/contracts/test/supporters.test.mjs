import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  SUPPORTER_KEY_PATTERN,
  tipIntentRequestSchema,
} from '../dist/index.js';

const key = 'A'.repeat(42) + '_';

test('supporterKey must be 43 base64url characters', () => {
  const quoteId = randomUUID();
  const parse = (supporterKey) =>
    tipIntentRequestSchema.safeParse({ quoteId, supporterKey }).success;
  assert.equal(parse(key), true);
  assert.equal(parse('-'.repeat(43)), true);
  assert.equal(parse('A'.repeat(42)), false);
  assert.equal(parse('A'.repeat(44)), false);
  // Standard base64's + / and = padding are not base64url.
  assert.equal(parse('A'.repeat(42) + '+'), false);
  assert.equal(parse('A'.repeat(42) + '='), false);
  assert.equal(parse(42), false);
  // Absent is the default: a tip without the tick sends nothing.
  assert.equal(tipIntentRequestSchema.safeParse({ quoteId }).success, true);
  assert.equal(SUPPORTER_KEY_PATTERN.test(key), true);
});
