import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  cardCostForm,
  cardCostSummary,
  cardOfferLine,
  koboToNaira,
  nairaToKobo,
} from '../src/lib/card-cost-view.ts';

// Owner, 26 Nov 2026: the card cost (rate, 3D Secure fixed cost, margin) on the Plan fees page, with
// where card is offered at the plan rates in force. The API decides again.

const DEFAULT = { rateBps: 200, fixedMinor: '4500', marginMinor: '1500' };
const RATES = { freeBps: 500, proBps: 300 };

test('the card cost reads as rate + fixed, margin', () => {
  assert.equal(cardCostSummary(DEFAULT), 'Card fee 2% + ₦45, margin ₦15');
  assert.equal(
    cardCostSummary({ rateBps: 250, fixedMinor: '4550', marginMinor: '0' }),
    'Card fee 2.5% + ₦45.50, margin ₦0',
  );
});

test('where card is offered, from the plan rates in force', () => {
  assert.equal(
    cardOfferLine(RATES, DEFAULT),
    'Card is offered on Free tips from ₦2,000 and Pro tips from ₦6,000',
  );
  // cardFromMinor(270) is 857,143 kobo, but the checkout rounds the share half up: at ₦8,571 it is
  // 23,142 kobo, which covers the cost exactly, so card is offered from ₦8,571.
  assert.equal(
    cardOfferLine({ freeBps: 500, proBps: 270 }, DEFAULT),
    'Card is offered on Free tips from ₦2,000 and Pro tips from ₦8,571',
  );
  // Review fix round 1: rounding up to ₦8,929 would show an amount where the checkout's rounded
  // share (16,161 kobo) misses the cost; card first appears at ₦8,930.
  assert.equal(
    cardOfferLine(
      { freeBps: 500, proBps: 181 },
      { rateBps: 125, fixedMinor: '5000', marginMinor: '0' },
    ),
    'Card is offered on Free tips from ₦1,334 and Pro tips from ₦8,930',
  );
  // A plan rate at or below the card rate never covers it.
  assert.equal(
    cardOfferLine({ freeBps: 500, proBps: 200 }, DEFAULT),
    'Card is offered on Free tips from ₦2,000; never on Pro tips',
  );
  assert.equal(
    cardOfferLine(RATES, { ...DEFAULT, rateBps: 500 }),
    'Card is never offered: neither plan’s fee covers the card fee rate',
  );
});

test('naira typed by staff becomes kobo, by integer parsing only', () => {
  assert.equal(nairaToKobo('45'), '4500');
  assert.equal(nairaToKobo('₦1,045.5'), '104550');
  assert.equal(nairaToKobo('0'), '0');
  assert.equal(nairaToKobo('0.05'), '5');
  for (const bad of ['', '-1', '4.555', 'abc', '1e3', '.5'])
    assert.equal(nairaToKobo(bad), null, bad);
  // And back, for the inputs' starting values.
  assert.equal(koboToNaira('4500'), '45');
  assert.equal(koboToNaira('4550'), '45.50');
  assert.equal(koboToNaira('0'), '0');
});

test('saving asks for a reason, checks each figure and refuses the cost in use', () => {
  const form = (over = {}) =>
    cardCostForm(
      {
        rate: '2.5',
        fixed: '50',
        margin: '20',
        reason: 'The partner’s new card price',
        ...over,
      },
      DEFAULT,
    );
  assert.deepEqual(form(), {
    ok: true,
    body: {
      rateBps: 250,
      fixedMinor: '5000',
      marginMinor: '2000',
      reason: 'The partner’s new card price',
    },
  });
  assert.deepEqual(form({ reason: '' }), {
    ok: false,
    error: 'Please write a reason of at least 10 characters.',
  });
  assert.equal(form({ reason: 'too short' }).ok, false);
  assert.match(form({ rate: '101' }).error, /percentage from 0 to 100/);
  assert.match(form({ fixed: '-5' }).error, /3D Secure/);
  assert.match(form({ margin: 'x' }).error, /margin/);
  assert.match(
    form({ rate: '2', fixed: '45', margin: '15' }).error,
    /different from the one in use/,
  );
});

test('the Plan fees page has the Card costs section under the plan rates', async () => {
  const page = await readFile(
    new URL('../src/app/ops/plan-fees/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(page, /<CardCosts\b/);
  const section = await readFile(
    new URL('../src/app/ops/plan-fees/card-costs.tsx', import.meta.url),
    'utf8',
  );
  assert.match(section, /Card costs/);
  assert.match(section, /\/v1\/ops\/card-costs/);
  assert.match(section, /Reason for this change/);
});
