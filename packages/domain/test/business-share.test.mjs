import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHARE_CAP_BPS,
  SHARE_NOTICE_DAYS,
  SHARE_OPTIONS_BPS,
  splitEqually,
  splitShare,
} from '../dist/index.js';

// Business release 2 (plan R2-0 Task 27): the share and team-split arithmetic every later PR uses.

test('the share options are the owner’s, capped at 50%, with 14 days’ notice', () => {
  assert.deepEqual([...SHARE_OPTIONS_BPS], [0, 1000, 2000, 3000, 5000]);
  assert.equal(SHARE_CAP_BPS, 5000);
  assert.ok(SHARE_OPTIONS_BPS.every((bps) => bps <= SHARE_CAP_BPS));
  assert.equal(SHARE_NOTICE_DAYS, 14);
});

test('splitShare: 90/10 of 1,801 kobo net gives the person 1,621 and the business 180 (share rounded down)', () => {
  assert.deepEqual(splitShare(1801n, 1000), {
    personMinor: 1621n,
    businessMinor: 180n,
  });
});

test('splitShare: every option adds up to the net, and the person never gets less than half', () => {
  for (const net of [1n, 2n, 3n, 999n, 180_000n, 450_001n])
    for (const bps of SHARE_OPTIONS_BPS) {
      const { personMinor, businessMinor } = splitShare(net, bps);
      assert.equal(personMinor + businessMinor, net);
      assert.ok(businessMinor >= 0n);
      assert.ok(personMinor * 2n >= net, `${net} at ${bps}`);
    }
  assert.deepEqual(splitShare(1801n, 0), {
    personMinor: 1801n,
    businessMinor: 0n,
  });
  // 50/50 of an odd amount: the remainder kobo stays with the person.
  assert.deepEqual(splitShare(3n, 5000), {
    personMinor: 2n,
    businessMinor: 1n,
  });
});

test('splitShare refuses bps outside the options and above 5000', () => {
  for (const bps of [-1000, 500, 1500, 4000, 6000, 10000, 1000.5, NaN])
    assert.throws(() => splitShare(1801n, bps), RangeError, String(bps));
  assert.throws(() => splitShare(0n, 1000), RangeError);
  assert.throws(() => splitShare(-5n, 1000), RangeError);
});

test('splitEqually: 1,000 kobo among 3 gives 334, 333, 333 (first takes the remainder)', () => {
  assert.deepEqual(splitEqually(1000n, 3), [334n, 333n, 333n]);
  assert.deepEqual(splitEqually(1000n, 1), [1000n]);
  assert.deepEqual(splitEqually(1001n, 4), [251n, 250n, 250n, 250n]);
});

test('splitEqually always adds up and every part is at least 1 kobo', () => {
  for (const total of [7n, 100n, 180_001n])
    for (let n = 1; n <= 7; n++) {
      const parts = splitEqually(total, n);
      assert.equal(parts.length, n);
      assert.equal(
        parts.reduce((sum, part) => sum + part, 0n),
        total,
      );
      assert.ok(parts.every((part) => part >= 1n));
      // The first part carries the whole remainder (M17), so it is ahead by less than n kobo.
      assert.ok(parts[0] - parts[n - 1] < BigInt(n));
    }
});

test('splitEqually refuses nobody, a fraction of a person, or less than a kobo each', () => {
  assert.throws(() => splitEqually(1000n, 0), RangeError);
  assert.throws(() => splitEqually(1000n, 1.5), RangeError);
  assert.throws(() => splitEqually(2n, 3), RangeError);
  assert.throws(() => splitEqually(0n, 1), RangeError);
});
