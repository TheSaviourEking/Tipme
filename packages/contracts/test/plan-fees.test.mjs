import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPS_CATALOGUE,
  PLAN_FEE_LARGE_CHANGE_BPS,
  PLAN_FEE_MAX_BPS,
  PLAN_FEE_MIN_BPS,
  SERIOUS_ACTIONS,
  SERIOUS_ACTION_PERMISSIONS,
  SERIOUS_ACTION_WORDS,
  opsPlanFeesChangeSchema,
} from '../dist/index.js';

// Owner, 18 Nov 2026: TipMe's share per plan is an admin setting; a change is a money change.

const REASON = 'The owner’s new rates, 18 Nov 2026';

test('plan_fees.change is a serious action on fees.manage, which is sensitive', () => {
  assert.ok(SERIOUS_ACTIONS.includes('plan_fees.change'));
  assert.equal(SERIOUS_ACTION_PERMISSIONS['plan_fees.change'], 'fees.manage');
  assert.match(SERIOUS_ACTION_WORDS['plan_fees.change'], /fee per plan/);
  assert.equal(OPS_CATALOGUE['fees.manage'].sensitive, true);
});

test('a change takes whole basis points 150 to 1000, Pro never above Free', () => {
  const ok = (freeBps, proBps, extra = {}) =>
    opsPlanFeesChangeSchema.safeParse({
      freeBps,
      proBps,
      reason: REASON,
      ...extra,
    }).success;
  assert.equal(PLAN_FEE_MIN_BPS, 150);
  assert.equal(PLAN_FEE_MAX_BPS, 1000);
  assert.equal(PLAN_FEE_LARGE_CHANGE_BPS, 200);
  assert.equal(ok('500', '300'), true);
  assert.equal(ok('150', '150'), true);
  assert.equal(ok('1000', '1000'), true);
  assert.equal(ok('500', '500'), true);
  assert.equal(ok('300', '500'), false);
  assert.equal(ok('1001', '300'), false);
  assert.equal(ok('500', '149'), false);
  assert.equal(ok('0', '0'), false);
  assert.equal(ok('10000', '10000'), false);
  assert.equal(ok('-1', '300'), false);
  assert.equal(ok('5.5', '3'), false);
  assert.equal(ok('0500', '300'), false);
  assert.equal(ok(500, 300), false);
  // The explicit confirm for a big move is a flag, true or absent.
  assert.equal(ok('800', '300', { confirmLargeChange: true }), true);
  assert.equal(ok('800', '300', { confirmLargeChange: 'yes' }), false);
  assert.equal(
    opsPlanFeesChangeSchema.safeParse({ freeBps: '500', proBps: '300' })
      .success,
    false,
  );
});
