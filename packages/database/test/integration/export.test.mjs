import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  exportMyTipsCsv,
  markAttemptInitiated,
  recordProviderEvent,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

test('a recipient’s CSV has the 10% amounts and status, never message text', async (t) => {
  const database = await useDatabase(t);
  const { db } = database;
  await database.fresh();
  const quote = await createQuote(db, {
    handle: 'ada',
    tipMinor: 250050n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    payerDisplayLabel: '=cmd',
    message: 'my secret note',
  });
  const reference = `mock_pay_${randomUUID()}`;
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 250050n,
    currency: 'NGN',
    providerFeeMinor: 3751n,
    signatureVerified: true,
    payload: {},
  });
  const { csv, rows } = await exportMyTipsCsv(db, ADA);
  assert.equal(rows, 1);
  const [header, line, end] = csv.split('\r\n');
  assert.equal(
    header,
    'Date (Lagos),From,Tip (NGN),"TipMe fee, processing included (NGN)",You received (NGN),Status,Reference ends',
  );
  const cells = line.split(',');
  // A supporter's name can never run as a spreadsheet formula.
  assert.equal(cells[1], "'=cmd");
  // ₦2,500.50: TipMe's 10% = ₦250.05 (processing included), Ada receives ₦2,250.45.
  assert.deepEqual(cells.slice(2, 6), ['2500.50', '250.05', '2250.45', 'Paid']);
  assert.equal(cells[6], reference.slice(-6));
  assert.equal(end, '');
  assert.equal(csv.includes('secret'), false);
});
