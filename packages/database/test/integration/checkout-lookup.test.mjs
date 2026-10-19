import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  findCheckoutByReference,
  markAttemptInitiated,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

test('minor: the pretend checkout charges what the quote says the payer pays', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const quote = await createQuote(database.db, {
    handle: 'tobi',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `mock_pay_${randomUUID()}`;
  await markAttemptInitiated(database.db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  const checkout = await findCheckoutByReference(
    database.db,
    'mock',
    reference,
  );
  assert.equal(checkout.chargeMinor, quote.breakdown.payerTotalMinor);
  assert.equal(checkout.attemptStatus, 'INITIATED');
});
