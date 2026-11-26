import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CARD_COST,
  cardFromMinor,
  checkoutMethodsFor,
} from '../dist/index.js';

const card = DEFAULT_CARD_COST;
const both = ['bank_transfer', 'card'];
const bank = ['bank_transfer'];
const methods = (amountMinor, tipmeShareMinor) =>
  checkoutMethodsFor({ amountMinor, tipmeShareMinor, card });

test('default card cost', () => {
  assert.deepEqual(card, {
    rateBps: 200n,
    fixedMinor: 4500n,
    marginMinor: 1500n,
  });
});

test('Free 5%, N2,000: boundary (equal) offers card', () => {
  assert.deepEqual(methods(200000n, 10000n), both);
});

test('Pro 3%, N5,000: bank transfer only', () => {
  assert.deepEqual(methods(500000n, 15000n), bank);
});

test('Pro 3%, N6,000: boundary offers card', () => {
  assert.deepEqual(methods(600000n, 18000n), both);
});

test('Pro 3%, N5,999: bank transfer only', () => {
  assert.deepEqual(methods(599900n, 17997n), bank);
});

test('Pro 3%, N10,000: both', () => {
  assert.deepEqual(methods(1000000n, 30000n), both);
});

test('fee-free, N100,000: bank transfer only', () => {
  assert.deepEqual(methods(10000000n, 0n), bank);
});

test('cardFromMinor', () => {
  assert.equal(cardFromMinor(300n, card), 600000n);
  assert.equal(cardFromMinor(500n, card), 200000n);
  assert.equal(cardFromMinor(200n, card), null);
  assert.equal(cardFromMinor(150n, card), null);
});
