import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPS_CATALOGUE,
  PLAN_FEE_MAX_BPS,
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

test('a change takes whole basis points 0 to 10000, Pro never above Free', () => {
  const ok = (freeBps, proBps) =>
    opsPlanFeesChangeSchema.safeParse({ freeBps, proBps, reason: REASON })
      .success;
  assert.equal(PLAN_FEE_MAX_BPS, 10000);
  assert.equal(ok('500', '300'), true);
  assert.equal(ok('0', '0'), true);
  assert.equal(ok('10000', '10000'), true);
  assert.equal(ok('500', '500'), true);
  assert.equal(ok('300', '500'), false);
  assert.equal(ok('10001', '0'), false);
  assert.equal(ok('-1', '0'), false);
  assert.equal(ok('5.5', '3'), false);
  assert.equal(ok('0500', '300'), false);
  assert.equal(ok(500, 300), false);
  assert.equal(
    opsPlanFeesChangeSchema.safeParse({ freeBps: '500', proBps: '300' })
      .success,
    false,
  );
});
