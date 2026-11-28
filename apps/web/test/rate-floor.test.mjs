import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAGE_FEE_MIN_BPS, PLAN_FEE_MIN_BPS } from '@tipme/contracts';
import {
  BELOW_FLOOR,
  RATE_FLOOR_BPS,
  pageRateBelowFloor,
  planRateBelowFloor,
  rateCardLine,
  typedRateCardLine,
} from '../src/lib/rate-floor.ts';

// Profit guards, Part 3 (26 Nov 2026): the ops Plan fees and Page pricing screens show where card
// starts at a rate, and flag a stored rate under the 2% floor. The API refuses such a new rate.

const COST = { rateBps: 200, fixedMinor: '4500', marginMinor: '1500' };

test('the screens’ floor is the contracts’ floor', () => {
  assert.equal(RATE_FLOOR_BPS, PLAN_FEE_MIN_BPS);
  assert.equal(RATE_FLOOR_BPS, PAGE_FEE_MIN_BPS);
  assert.equal(BELOW_FLOOR, 'Below the 2% floor');
});

test('plan fees: at 300 bps card is offered from ₦6,000; at 200 it is not offered', () => {
  assert.equal(rateCardLine(300, COST), 'Card is offered on tips from ₦6,000.');
  assert.equal(rateCardLine(200, COST), 'Card is not offered at this rate.');
  assert.equal(rateCardLine(500, COST), 'Card is offered on tips from ₦2,000.');
  // Until the card cost has loaded there is nothing honest to say.
  assert.equal(rateCardLine(300, null), null);
});

test('a typed rate shows its card line only when it is a rate the API would accept', () => {
  assert.equal(
    typedRateCardLine('3', COST),
    'Card is offered on tips from ₦6,000.',
  );
  assert.equal(
    typedRateCardLine('2', COST),
    'Card is not offered at this rate.',
  );
  assert.equal(typedRateCardLine('1.5', COST), null);
  assert.equal(typedRateCardLine('abc', COST), null);
  assert.equal(typedRateCardLine('', COST), null);
});

test('a stored plan rate of 150 bps is flagged; 200 and up is not', () => {
  assert.equal(planRateBelowFloor(150), true);
  assert.equal(planRateBelowFloor(199), true);
  assert.equal(planRateBelowFloor(200), false);
  assert.equal(planRateBelowFloor(500), false);
});

test('a stored page rate of 100 bps is flagged; none, 0 (fee-free) and 200 up are not', () => {
  assert.equal(pageRateBelowFloor(100), true);
  assert.equal(pageRateBelowFloor(1), true);
  assert.equal(pageRateBelowFloor(199), true);
  assert.equal(pageRateBelowFloor(200), false);
  assert.equal(pageRateBelowFloor(0), false);
  assert.equal(pageRateBelowFloor(null), false);
});
