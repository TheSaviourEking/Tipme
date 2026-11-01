import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentMode } from '../src/lib/payment-mode.ts';

test('every provider and live switch maps to one payment mode', () => {
  const cases = [
    ['mock', false, 'test'],
    ['mock', true, 'test'],
    ['bachs-sandbox', false, 'test'],
    ['bachs-sandbox', true, 'test'],
    ['bachs-live', false, 'closed'],
    ['bachs-live', true, 'live'],
  ];
  for (const [paymentProvider, paymentsLive, mode] of cases)
    assert.equal(
      paymentMode({ paymentProvider, paymentsLive }),
      mode,
      `${paymentProvider} with paymentsLive ${paymentsLive}`,
    );
});

test('an answer that cannot be read is closed', () => {
  for (const release of [
    undefined,
    null,
    'ok',
    {},
    { paymentProvider: 'stripe', paymentsLive: true },
    { paymentProvider: 'bachs-live' },
    { paymentProvider: 'bachs-live', paymentsLive: 'true' },
  ])
    assert.equal(paymentMode(release), 'closed', JSON.stringify(release));
});
