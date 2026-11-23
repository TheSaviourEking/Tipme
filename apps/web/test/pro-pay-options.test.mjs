import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proPayOptions } from '../src/lib/pro-pay-options.ts';

// Paying for Pro (owner, 23 Nov 2026): a You collect recipient whose balance can't pay for the
// month is offered card or bank transfer only, never a balance payment that would only be refused.
const PRICE = '500000';
const of = (over = {}) =>
  proPayOptions({
    methods: ['card', 'balance'],
    priceMinor: PRICE,
    mode: 'direct',
    availableMinor: '0',
    ...over,
  });

test('card or bank transfer is always offered', () => {
  assert.deepEqual(of({ methods: ['card'] }), ['checkout']);
});

test('a direct recipient keeps the balance option as today, whatever the balance', () => {
  assert.deepEqual(of(), ['checkout', 'balance']);
  assert.deepEqual(of({ availableMinor: null }), ['checkout', 'balance']);
});

test('a collect recipient with no balance is offered card or bank transfer only', () => {
  assert.deepEqual(of({ mode: 'collect', availableMinor: '0' }), ['checkout']);
});

test('a collect recipient whose balance is less than the price is not offered the balance', () => {
  assert.deepEqual(of({ mode: 'collect', availableMinor: '499999' }), [
    'checkout',
  ]);
});

test('a collect recipient whose balance covers the price can pay from it', () => {
  assert.deepEqual(of({ mode: 'collect', availableMinor: PRICE }), [
    'checkout',
    'balance',
  ]);
});

test('while the mode or the balance is unknown, the balance is not offered', () => {
  assert.deepEqual(of({ mode: null }), ['checkout']);
  assert.deepEqual(of({ mode: 'collect', availableMinor: null }), ['checkout']);
});

test('the switch off still means no balance for anyone', () => {
  assert.deepEqual(
    of({ methods: ['card'], mode: 'collect', availableMinor: '900000' }),
    ['checkout'],
  );
});
