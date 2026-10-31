import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  tipIntentRequestSchema,
  tipQuoteRequestSchema,
} from '../dist/index.js';

test('quote requests are strict, NGN-only, with string amounts', () => {
  assert.equal(
    tipQuoteRequestSchema.safeParse({
      handle: 'ada',
      amountMinor: '100000',
      currency: 'NGN',
    }).success,
    true,
  );
  assert.equal(
    tipQuoteRequestSchema.safeParse({
      handle: 'ada',
      amountMinor: 100000,
      currency: 'NGN',
    }).success,
    false,
  );
  assert.equal(
    tipQuoteRequestSchema.safeParse({
      handle: 'ada',
      amountMinor: '100000',
      currency: 'USD',
    }).success,
    false,
  );
  assert.equal(
    tipQuoteRequestSchema.safeParse({
      handle: 'ada',
      amountMinor: '1',
      currency: 'NGN',
      x: 1,
    }).success,
    false,
  );
});

test('intent requests are strict and bounded', () => {
  const quoteId = randomUUID();
  assert.equal(
    tipIntentRequestSchema.safeParse({ quoteId, message: 'Thanks!' }).success,
    true,
  );
  assert.equal(
    tipIntentRequestSchema.safeParse({ quoteId, purpose: 'great_service' })
      .success,
    true,
  );
  assert.equal(
    tipIntentRequestSchema.safeParse({ quoteId, purpose: 'other_reason' })
      .success,
    false,
  );
  assert.equal(
    tipIntentRequestSchema.safeParse({ quoteId, message: 'x'.repeat(281) })
      .success,
    false,
  );
  assert.equal(
    tipIntentRequestSchema.safeParse({ quoteId: 'nope' }).success,
    false,
  );
  assert.equal(
    tipIntentRequestSchema.safeParse({ quoteId, returnPath: '/x' }).success,
    false,
  );
});
