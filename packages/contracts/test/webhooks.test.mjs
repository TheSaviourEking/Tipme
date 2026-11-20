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

// You collect (plan Task 5): the pretend partner can raise disputes on TipMe's own account and say an
// account's capability changed. The new fields are optional and as strict as the rest.
test('mock dispute and capability webhooks are strictly validated', () => {
  const dispute = {
    id: 'evt_dsp_1',
    type: 'dispute.created',
    data: {
      reference: 'mock_dsp_1',
      disputeId: 'mock_dsp_1',
      status: 'open',
      respondBy: '2026-12-02T00:00:00.000Z',
      amountMinor: '1000000',
      currency: 'NGN',
      feeMinor: '1500',
      feeCurrency: 'USD',
    },
  };
  assert.equal(mockWebhookSchema.safeParse(dispute).success, true);
  assert.equal(
    mockWebhookSchema.safeParse({ ...dispute, type: 'dispute.updated' })
      .success,
    true,
  );
  for (const data of [
    { status: 'needs_response' },
    { respondBy: 'next week' },
    { feeCurrency: 'usd' },
    { disputeId: 'bad\u0000id' },
    { feeMinor: '-1' },
  ])
    assert.equal(
      mockWebhookSchema.safeParse({
        ...dispute,
        data: { ...dispute.data, ...data },
      }).success,
      false,
      JSON.stringify(data),
    );
  assert.equal(
    mockWebhookSchema.safeParse({
      id: 'evt_cap_1',
      type: 'capability.updated',
      data: {
        reference: 'mock_acct_1',
        accountReference: 'mock_acct_1',
        amountMinor: '0',
        currency: 'NGN',
        feeMinor: '0',
      },
    }).success,
    true,
  );
  // Payment events are unchanged.
  assert.equal(mockWebhookSchema.safeParse(valid).success, true);
});
