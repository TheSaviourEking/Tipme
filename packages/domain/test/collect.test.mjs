import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLLECT_TRANSFER_STATUSES,
  COLLECT_TRANSFER_TRANSITIONS,
  DISPUTE_STATUSES,
  canTransition,
  collectRefundPlan,
  disputeRecovery,
  disputeStatusAfter,
} from '../dist/index.js';

// Deterministic LCG (same as ledger.test.mjs) so failures are reproducible.
let seed = 42n;
const next = (max) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
  return seed % max;
};

test('a collect transfer never leaves paid or cancelled, and sent never goes straight to cancelled', () => {
  assert.deepEqual(COLLECT_TRANSFER_TRANSITIONS, {
    waiting: ['ready', 'cancelled', 'review'],
    ready: ['sent', 'waiting', 'cancelled', 'review'],
    sent: ['paid', 'unknown', 'ready', 'waiting', 'review'],
    unknown: ['paid', 'ready', 'review'],
    review: ['ready', 'waiting', 'cancelled', 'paid'],
    paid: [],
    cancelled: [],
  });
  for (const from of COLLECT_TRANSFER_STATUSES) {
    for (const to of COLLECT_TRANSFER_STATUSES) {
      if (from === 'paid' || from === 'cancelled') {
        assert.equal(
          canTransition(COLLECT_TRANSFER_TRANSITIONS, from, to),
          false,
        );
      }
    }
  }
  assert.equal(
    canTransition(COLLECT_TRANSFER_TRANSITIONS, 'sent', 'cancelled'),
    false,
  );
  assert.equal(
    canTransition(COLLECT_TRANSFER_TRANSITIONS, 'unknown', 'cancelled'),
    false,
  );
  // Review stays generic (Ruling P13): any reason can enter it from every live state.
  for (const from of ['waiting', 'ready', 'sent', 'unknown']) {
    assert.equal(
      canTransition(COLLECT_TRANSFER_TRANSITIONS, from, 'review'),
      true,
    );
  }
});

// Task 3 fix round 1: a share held for review before the recipient had any bank account can't go to
// `ready` (the database needs an account there), so review releases it back to `waiting`.
test('a waiting share goes to review and can be released back to waiting', () => {
  assert.equal(
    canTransition(COLLECT_TRANSFER_TRANSITIONS, 'waiting', 'review'),
    true,
  );
  assert.equal(
    canTransition(COLLECT_TRANSFER_TRANSITIONS, 'review', 'waiting'),
    true,
  );
});

test('dispute status is out-of-order safe', () => {
  assert.equal(disputeStatusAfter('lost', 'open'), 'lost');
  assert.equal(disputeStatusAfter('open', 'responded'), 'responded');
  assert.equal(disputeStatusAfter('lost', 'won'), 'lost');
  assert.equal(disputeStatusAfter('responded', 'open'), 'responded');
  assert.equal(disputeStatusAfter('open', 'won'), 'won');
  assert.equal(disputeStatusAfter('responded', 'closed'), 'closed');
  assert.equal(disputeStatusAfter('open', 'open'), 'open');
  // Property: final states never move, and the result is never a step back.
  const rank = { open: 0, responded: 1, won: 2, lost: 2, closed: 2 };
  for (const a of DISPUTE_STATUSES) {
    for (const b of DISPUTE_STATUSES) {
      const r = disputeStatusAfter(a, b);
      if (rank[a] === 2) assert.equal(r, a);
      assert.ok(rank[r] >= rank[a]);
    }
  }
});

test('a refund cancels a held share, takes back a moved one, and stops for staff when it was withdrawn', () => {
  assert.deepEqual(
    collectRefundPlan({
      refundMinor: 950000n,
      share: { state: 'held', heldMinor: 950000n },
    }),
    { kind: 'cancel_held' },
  );
  assert.deepEqual(
    collectRefundPlan({
      refundMinor: 950000n,
      share: { state: 'moved', inBalanceMinor: 950000n },
    }),
    { kind: 'take_back', backMinor: 950000n },
  );
  assert.deepEqual(
    collectRefundPlan({
      refundMinor: 950000n,
      share: { state: 'moved', inBalanceMinor: 200000n },
    }),
    { kind: 'staff_decides', gapMinor: 750000n },
  );
  // More in balance than needed: only the refund amount comes back.
  assert.deepEqual(
    collectRefundPlan({
      refundMinor: 950000n,
      share: { state: 'moved', inBalanceMinor: 2000000n },
    }),
    { kind: 'take_back', backMinor: 950000n },
  );
});

test('a lost dispute recovers from what is held first, then what is still in their balance, then TipMe', () => {
  const base = { disputedMinor: 1000000n, netMinor: 950000n };
  assert.deepEqual(
    disputeRecovery({ ...base, share: { state: 'held', heldMinor: 950000n } }),
    { fromHeldMinor: 950000n, backMinor: 0n, absorbedMinor: 50000n },
  );
  assert.deepEqual(
    disputeRecovery({
      ...base,
      share: { state: 'moved', inBalanceMinor: 400000n },
    }),
    { fromHeldMinor: 0n, backMinor: 400000n, absorbedMinor: 600000n },
  );
  assert.deepEqual(
    disputeRecovery({ ...base, share: { state: 'moved', inBalanceMinor: 0n } }),
    { fromHeldMinor: 0n, backMinor: 0n, absorbedMinor: 1000000n },
  );
  // Property: parts add up to the dispute, and the recipient never gives back more than net.
  for (let i = 0; i < 500; i++) {
    const net = 1n + next(5_000_000n);
    const disputed = net + next(500_000n);
    const amount = next(8_000_000n);
    const share =
      next(2n) === 0n
        ? { state: 'held', heldMinor: amount }
        : { state: 'moved', inBalanceMinor: amount };
    const r = disputeRecovery({
      disputedMinor: disputed,
      netMinor: net,
      share,
    });
    assert.equal(r.fromHeldMinor + r.backMinor + r.absorbedMinor, disputed);
    assert.ok(r.fromHeldMinor + r.backMinor <= net);
    assert.ok(
      r.fromHeldMinor >= 0n && r.backMinor >= 0n && r.absorbedMinor >= 0n,
    );
  }
});

test('a refund or dispute on an in-flight transfer waits', () => {
  assert.deepEqual(
    collectRefundPlan({ refundMinor: 950000n, share: { state: 'in_flight' } }),
    { kind: 'wait' },
  );
  assert.deepEqual(
    disputeRecovery({
      disputedMinor: 1000000n,
      netMinor: 950000n,
      share: { state: 'in_flight' },
    }),
    { wait: true },
  );
});
