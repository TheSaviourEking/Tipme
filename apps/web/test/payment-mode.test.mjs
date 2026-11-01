import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPaymentModeReader,
  paymentMode,
} from '../src/lib/payment-mode.ts';

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

test('a good answer is shared for a minute, a failed read for a few seconds only', async () => {
  let clock = 0;
  const answers = [];
  const reads = [];
  const read = createPaymentModeReader({
    read: async () => {
      reads.push(clock);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => clock,
  });

  // The build (or a cold start) cannot reach the API: closed, but only briefly.
  answers.push(new Error('connect ECONNREFUSED'));
  assert.equal(await read(), 'closed');
  clock = 4_000;
  assert.equal(await read(), 'closed');
  assert.equal(reads.length, 1);
  clock = 5_000;
  answers.push({ paymentProvider: 'mock', paymentsLive: false });
  assert.equal(await read(), 'test');
  assert.equal(reads.length, 2);

  // A good answer is reused for 60 seconds, then read again.
  clock = 64_999;
  assert.equal(await read(), 'test');
  assert.equal(reads.length, 2);
  clock = 65_000;
  answers.push({ paymentProvider: 'bachs-live', paymentsLive: true });
  assert.equal(await read(), 'live');
  assert.equal(reads.length, 3);
});

test('requests at the same moment share one read', async () => {
  let calls = 0;
  const read = createPaymentModeReader({
    read: async () => {
      calls += 1;
      return { paymentProvider: 'bachs-sandbox', paymentsLive: false };
    },
    now: () => 0,
  });
  assert.deepEqual(await Promise.all([read(), read(), read()]), [
    'test',
    'test',
    'test',
  ]);
  assert.equal(calls, 1);
});

test('on a live copy only a page the API says is open takes tips; other modes are unaffected', async () => {
  const { profileTippingClosed } = await import('../src/lib/payment-mode.ts');
  assert.equal(profileTippingClosed('live', { tippingOpen: true }), false);
  assert.equal(profileTippingClosed('live', { tippingOpen: false }), true);
  // An API that doesn't say: never a pay button on a guess, when money is real.
  assert.equal(profileTippingClosed('live', {}), true);
  assert.equal(profileTippingClosed('test', {}), false);
  assert.equal(profileTippingClosed('test', { tippingOpen: false }), false);
  assert.equal(profileTippingClosed('closed', {}), true);
});
