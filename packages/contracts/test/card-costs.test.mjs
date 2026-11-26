import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPS_CATALOGUE,
  SERIOUS_ACTIONS,
  SERIOUS_ACTION_PERMISSIONS,
  SERIOUS_ACTION_WORDS,
  opsCardCostsChangeSchema,
} from '../dist/index.js';

// Owner, 26 Nov 2026: what a card payment costs TipMe is an ops setting, changed like plan fees.

const REASON = 'The partner’s new card price, 26 Nov 2026';

test('card_costs.change is a serious action on fees.manage, which is sensitive', () => {
  assert.ok(SERIOUS_ACTIONS.includes('card_costs.change'));
  assert.equal(SERIOUS_ACTION_PERMISSIONS['card_costs.change'], 'fees.manage');
  assert.match(SERIOUS_ACTION_WORDS['card_costs.change'], /card cost/i);
  assert.equal(OPS_CATALOGUE['fees.manage'].sensitive, true);
});

test('a change takes a rate of 0 to 10000 bps and kobo amounts of 0 or more, with a reason', () => {
  const ok = (rateBps, fixedMinor, marginMinor, extra = {}) =>
    opsCardCostsChangeSchema.safeParse({
      rateBps,
      fixedMinor,
      marginMinor,
      reason: REASON,
      ...extra,
    }).success;
  assert.equal(ok(200, '4500', '1500'), true);
  assert.equal(ok(0, '0', '0'), true);
  assert.equal(ok(10000, '4550', '0'), true);
  assert.equal(ok(10001, '4500', '1500'), false);
  assert.equal(ok(-1, '4500', '1500'), false);
  assert.equal(ok(2.5, '4500', '1500'), false);
  assert.equal(ok('200', '4500', '1500'), false);
  assert.equal(ok(200, '-1', '1500'), false);
  assert.equal(ok(200, '4500', '-1'), false);
  assert.equal(ok(200, '45.00', '1500'), false);
  assert.equal(ok(200, '04500', '1500'), false);
  assert.equal(ok(200, 4500, '1500'), false);
  assert.equal(ok(200, '4500', ''), false);
  assert.equal(ok(200, '4500', '1500', { extra: true }), false);
  assert.equal(
    opsCardCostsChangeSchema.safeParse({
      rateBps: 200,
      fixedMinor: '4500',
      marginMinor: '1500',
    }).success,
    false,
  );
});
