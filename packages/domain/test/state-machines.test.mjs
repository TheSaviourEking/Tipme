import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  TIP_STATUSES,
  TIP_TRANSITIONS,
  canTransition,
} from '../dist/index.js';

const allowed = {
  tip: {
    DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
    AWAITING_PAYMENT: [
      'PENDING_VERIFICATION',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
    ],
    PENDING_VERIFICATION: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
    SUCCEEDED: [],
    FAILED: [],
    CANCELLED: [],
  },
  attempt: {
    CREATED: [
      'STARTING',
      'INITIATED',
      'PENDING',
      'VERIFIED_SUCCEEDED',
      'VERIFIED_FAILED',
      'EXPIRED',
      'UNKNOWN',
    ],
    STARTING: [
      'INITIATED',
      'PENDING',
      'VERIFIED_SUCCEEDED',
      'VERIFIED_FAILED',
      'UNKNOWN',
    ],
    INITIATED: [
      'PENDING',
      'VERIFIED_SUCCEEDED',
      'VERIFIED_FAILED',
      'EXPIRED',
      'UNKNOWN',
    ],
    PENDING: ['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'EXPIRED', 'UNKNOWN'],
    UNKNOWN: ['PENDING', 'VERIFIED_SUCCEEDED', 'VERIFIED_FAILED'],
    VERIFIED_SUCCEEDED: [],
    VERIFIED_FAILED: [],
    EXPIRED: [],
  },
  payout: {
    REQUESTED: ['PROCESSING', 'PAID', 'FAILED'],
    PROCESSING: ['PAID', 'FAILED'],
    PAID: ['REVERSED'],
    FAILED: [],
    REVERSED: [],
  },
};

for (const [name, table, statuses] of [
  ['tip', TIP_TRANSITIONS, TIP_STATUSES],
  ['attempt', ATTEMPT_TRANSITIONS, ATTEMPT_STATUSES],
  ['payout', PAYOUT_TRANSITIONS, PAYOUT_STATUSES],
]) {
  test(`${name} transitions are exactly the PRD set`, () => {
    assert.deepEqual([...statuses].sort(), Object.keys(allowed[name]).sort());
    for (const from of statuses) {
      for (const to of statuses) {
        assert.equal(
          canTransition(table, from, to),
          allowed[name][from].includes(to),
          `${from}->${to}`,
        );
      }
    }
  });
}

test('terminal states never move backwards', () => {
  assert.equal(canTransition(TIP_TRANSITIONS, 'SUCCEEDED', 'FAILED'), false);
  assert.equal(
    canTransition(ATTEMPT_TRANSITIONS, 'UNKNOWN', 'VERIFIED_SUCCEEDED'),
    true,
  );
});
