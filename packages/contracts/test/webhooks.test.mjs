import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mockWebhookSchema } from '../dist/index.js';

const valid = {
  id: 'evt_1',
  type: 'payment.succeeded',
  data: {
    reference: 'mock_pay_1',
    attemptId: randomUUID(),
    amountMinor: '100000',
    currency: 'NGN',
    feeMinor: '1500',
  },
};

test('mock webhooks are strictly validated, with amounts as strings', () => {
  assert.equal(mockWebhookSchema.safeParse(valid).success, true);
  assert.equal(
    mockWebhookSchema.safeParse({
      ...valid,
      data: { ...valid.data, amountMinor: 100000 },
    }).success,
    false,
  );
  assert.equal(
    mockWebhookSchema.safeParse({ ...valid, type: 'payment.refunded' }).success,
    false,
  );
  assert.equal(
    mockWebhookSchema.safeParse({ ...valid, extra: true }).success,
    false,
  );
});
