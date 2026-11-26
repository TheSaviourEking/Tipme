import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CARD_COST,
  basisPointsOf,
  cardFromMinor,
  cardOfferedFromNaira,
  checkoutMethodsFor,
  priceTip,
  feePolicyForPlan,
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

test('cardFromMinor rounds up to the next kobo', () => {
  // 60,000,000 / 70 = 857,142.86: the first amount that covers the card cost is 857,143.
  assert.equal(cardFromMinor(270n, card), 857143n);
});

test('basisPointsOf rounds half up, as the quote prices TipMe’s share', () => {
  assert.equal(basisPointsOf(892900n, 181n), 16161n);
  assert.equal(basisPointsOf(10050n, 500n), 503n); // 502.5 → 503
  assert.equal(basisPointsOf(10010n, 500n), 501n); // 500.5 → 501
  // The same share priceTip charges.
  const tip = priceTip(1234567n, feePolicyForPlan('pro'));
  assert.equal(
    tip.platformFeeMinor + tip.providerFeeMinor,
    basisPointsOf(1234567n, 300n),
  );
});

test('cardOfferedFromNaira: the whole naira from which a checkout really offers card', () => {
  // The defaults land exactly on whole naira: ₦2,000 Free, ₦6,000 Pro.
  assert.equal(cardOfferedFromNaira(500n, card), 200000n);
  assert.equal(cardOfferedFromNaira(300n, card), 600000n);
  // cardFromMinor(270) is 857,143 kobo, but at ₦8,571 the rounded share (23,142) already covers it.
  assert.equal(cardOfferedFromNaira(270n, card), 857100n);
  assert.equal(cardOfferedFromNaira(200n, card), null);
  // Rounding cardFromMinor up to ₦8,929 is not enough: the quote rounds the share to 16,161 kobo,
  // which misses the cost by a fraction; card first appears at ₦8,930.
  const tight = { rateBps: 125n, fixedMinor: 5000n, marginMinor: 0n };
  assert.equal(cardFromMinor(181n, tight), 892858n);
  const offers = (amount) =>
    checkoutMethodsFor({
      amountMinor: amount,
      tipmeShareMinor: basisPointsOf(amount, 181n),
      card: tight,
    }).includes('card');
  assert.equal(offers(892900n), false);
  assert.equal(cardOfferedFromNaira(181n, tight), 893000n);
  assert.equal(offers(893000n), true);
});

test('cardOfferedFromNaira matches checkoutMethodsFor on every whole naira around the line', () => {
  // A brute-force check over many plan rates and costs: below the answer no whole naira offers card,
  // at the answer and for the next ₦2,000 every one does.
  for (const planBps of [201n, 203n, 250n, 300n, 333n, 500n, 1000n])
    for (const cost of [
      card,
      { rateBps: 125n, fixedMinor: 5000n, marginMinor: 0n },
      { rateBps: 199n, fixedMinor: 4550n, marginMinor: 7n },
    ]) {
      const from = cardOfferedFromNaira(planBps, cost);
      if (from === null) continue;
      const offers = (amount) =>
        checkoutMethodsFor({
          amountMinor: amount,
          tipmeShareMinor: basisPointsOf(amount, planBps),
          card: cost,
        }).includes('card');
      assert.equal(from % 100n, 0n);
      assert.equal(offers(from - 100n), false, `${planBps} below`);
      for (let a = from; a < from + 200000n; a += 100n)
        assert.equal(offers(a), true, `${planBps} at ${a}`);
    }
});
